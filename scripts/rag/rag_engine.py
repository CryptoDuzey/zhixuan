"""Local, evidence-returning retrieval. No credentials, remote inference, or generated facts."""
from __future__ import annotations

import argparse
from datetime import date
from collections import OrderedDict
import hashlib
import json
import os
import re
import threading
import time
import unicodedata

if __package__:
    from .rag_answer import make_answer, passages, service_intent, SERVICE_INTENTS
    from .rag_config import Config
    from .rag_corpus import (TEXT_EXT, CorpusChanged, corpus_files, fingerprint,
                             model_fingerprint, read_checked, scan_documents)
    from .rag_protocol import validate_query
else:
    from rag_answer import make_answer, passages, service_intent, SERVICE_INTENTS
    from rag_config import Config
    from rag_corpus import (TEXT_EXT, CorpusChanged, corpus_files, fingerprint,
                            model_fingerprint, read_checked, scan_documents)
    from rag_protocol import validate_query

VERSION = 2
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："
DEFAULT_RANKING = {"denseWeight": .55, "entityWeight": .24,
                   "mismatchPenalty": .8, "topicWeight": .16, "answerThreshold": .53}


def numeric_dependencies():
    """Import numerical dependencies only when building or loading an index."""
    global np, CountVectorizer
    try:
        import numpy as np
        from sklearn.feature_extraction.text import CountVectorizer
    except ImportError as exc:
        raise RuntimeError("缺少可选检索依赖，请使用已准备好 requirements.txt 依赖的环境") from exc


def norm(s):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s).lower())


def terms(s):
    s = unicodedata.normalize("NFKC", s).lower()
    result = re.findall(r"[a-z]+(?:[-.][a-z0-9]+)*|\d+(?:\.\d+)?", s)
    for phrase in re.findall(r"[\u4e00-\u9fff]+", s):
        if len(phrase) == 1:
            result.append(phrase)
        result.extend(phrase[i:i+2] for i in range(len(phrase)-1))
    return result


# Public product-name aliases and card routing rules; no source facts or labels.
ENTITIES = [
    ("d16se", ["matebook d 16 se", "d16se"], "MateBook D 16 SE 版"),
    ("d16", ["matebook d 16", "d16"], "MateBook D 16"),
    ("d14", ["matebook d 14", "d14"], "MateBook D 14"),
    ("pros", ["matebook pro s", "pro s", "pros"], "HUAWEI MateBook Pro S"),
    ("xpro", ["matebook x pro", "matebook x", "x pro", "xpro"], "MateBook X系列"),
    ("fold", ["matebook fold", "非凡大师", "折叠电脑"], "HUAWEI MateBook Fold 非凡大师"),
    ("gt", ["matebook gt", "gt14"], "MateBook GT 系列"),
    ("ultra14", ["matebook 14 酷睿", "matebook14ultra", "matebook14酷睿ultra"], "MateBook 14 酷睿 Ultra"),
    ("pro", ["matebook pro"], "HUAWEI MateBook Pro"),
    ("harmony14", ["matebook 14"], "HUAWEI MateBook 14"),
]


def identities(text):
    q = norm(text)
    matches = []
    for key, aliases, _ in ENTITIES:
        for alias in aliases:
            for m in re.finditer(re.escape(norm(alias)), q):
                matches.append((key, m.start(), m.end()))
    matches = [(key, start, end) for key, start, end in matches
               if not any(start >= s and end <= e and (start, end) != (s, e) for _, s, e in matches)]
    keys = list(dict.fromkeys(key for key, _, _ in matches))
    if "harmony14" in keys and not re.search(r"鸿蒙|harmony|麒麟", q) and re.search(r"酷睿|ultra|windows版|英特尔", q):
        keys = ["ultra14" if k == "harmony14" else k for k in keys]
    return keys


TOPICS = {
    "price": (r"多少钱|价格|售价|到手价|优惠|补贴|预算|价位", ["价格", "销售配置", "官方公开价格"], "价格卡"),
    "screen": (r"屏幕|显示规格|分辨率|清晰|护眼|oled|刷新率|柔光", ["屏幕", "显示", "分辨率", "OLED"], "02-屏幕与显示卡"),
    "port": (r"接口|插口|外设|插什么|扩展坞|hdmi|usb|投影仪|显示器|轻不轻|重不重|重量|多重|出差|通勤|电池|续航|充电|轻薄", ["接口", "便携", "续航", "电池", "USB"], "04-便携续航接口卡"),
    "memory": (r"内存|硬盘|存储|配置|处理器|芯片|cpu|性能|显卡", ["内存", "存储", "处理器", "配置"], "03-性能与存储卡"),
    "system": (r"系统|协同|互传|互联|手机|平板|迁移|软件|兼容|windows程序", ["系统", "协同", "生态", "兼容"], "05-系统协同与兼容卡"),
    "fit": (r"适合|适用|谁买|人群|使用限制|使用边界|哪些限制|避坑|不适合|缺点", ["适用人群", "限制", "适合"], "06-适用人群与限制卡"),
}
PLATFORMS = {"小红书": ["小红书", "种草笔记"], "朋友圈": ["朋友圈"],
             "微信公众号": ["公众号", "微信长文"], "门店海报": ["海报"], "抖音": ["抖音"],
             "知乎": ["知乎"], "B站": ["b站", "哔哩哔哩"], "直播": ["直播"]}


def analyze(q):
    n = norm(q)
    topics = [key for key, (pattern, _, _) in TOPICS.items() if re.search(pattern, n)]
    platforms = [key for key, aliases in PLATFORMS.items() if any(norm(a) in n for a in aliases)]
    ids = identities(q)
    ambiguous = ("harmony14" in ids and not re.search(r"鸿蒙|harmony|麒麟", n))
    if ambiguous:
        ids.append("ultra14")
    expanded = q + " " + " ".join(word for topic in topics for word in TOPICS[topic][1])
    expanded += " " + " ".join(platforms)
    issues = []
    known_tokens = {"14", "14ultra", "pro", "pros", "x", "xpro", "fold", "gt", "gt14", "d14", "d16", "d16se"}
    mentions = re.findall(r"matebook([a-z0-9]+)", n)
    if any(token not in known_tokens and not re.fullmatch(r"(?:14|d16|d16se|d14|xpro|pro|pros|fold|gt14)20\d{2}", token)
           for token in mentions):
        issues.append("资料中没有确认该型号，不能套用相近型号参数")
    if re.search(r"(?:身份证|银行卡|银行密码|未公开).*(?:号|码|密码)|(?:客户|顾客).*(?:密码|身份证)", n):
        issues.append("知识库不包含可提供的个人私密信息")
    if re.search(r"治愈|治疗近视|保证.*(?:所有|绝不)|所有.*(?:绝不|保证)|100%.*兼容", n):
        issues.append("资料不足以支持医疗效果或无条件绝对承诺")
    future = [int(y) for y in re.findall(r"(20\d{2})年", n)]
    if any(y > date.today().year for y in future) and re.search(r"价格|售价|准确|未发布", n):
        issues.append("下载资料不能证明未来未发布产品的准确事实")
    return {"entities": ids, "topics": topics, "platforms": platforms,
            "ambiguousModel": ambiguous, "expanded": expanded, "unsupportedReasons": issues}


def load_corpus(library):
    docs, chunks = [], []
    for p in corpus_files(library):
        relative = p.relative_to(library).as_posix()
        data = read_checked(library, relative)
        try:
            text = data.decode("utf-8") if p.suffix.lower() in TEXT_EXT else ""
        except UnicodeDecodeError:
            text = ""
        doc = {"id": hashlib.sha256(relative.encode()).hexdigest()[:24],
               "title": p.name, "path": relative, "sha256": hashlib.sha256(data).hexdigest(),
               "bytes": len(data), "textIndexed": bool(text), "entities": identities(relative)}
        di = len(docs)
        docs.append(doc)
        if not text:
            chunks.append({"doc": di, "text": "" if p.suffix.lower() in TEXT_EXT else relative,
                           "start": 0, "end": 0, "line": 1, "lineEnd": 1, "image": True})
            continue
        # Non-overlapping core is fully covered; overlap helps keep facts near boundaries together.
        start = 0
        while start < len(text):
            end = min(start + 420, len(text))
            if end < len(text):
                boundary = text.rfind("\n", start + 270, end)
                if boundary > start:
                    end = boundary + 1
            piece = text[start:end]
            chunks.append({"doc": di, "text": piece, "start": start, "end": end,
                           "line": text.count("\n", 0, start)+1,
                           "lineEnd": text.count("\n", 0, end)+1, "image": False})
            if end == len(text):
                break
            start = max(start+1, end-45)
    return docs, chunks


def embed_text(doc, chunk):
    parts = doc["path"].split("/")
    prefix = (parts[-2] if len(parts)>1 else "") + " " + doc["title"]
    return prefix[:80] + "\n" + chunk["text"]


def make_model(config):
    # Override inherited online settings: this optional module never downloads.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import torch
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise RuntimeError("缺少可选模型依赖，请使用已准备好 requirements.txt 依赖的环境") from exc
    torch.set_num_threads(4)
    return SentenceTransformer(str(config.model), device="cpu", local_files_only=True, trust_remote_code=False)


def build(config=None):
    config = config or Config.from_env()
    config.validate()
    numeric_dependencies()
    store = config.store
    store.mkdir(parents=True, exist_ok=True)
    docs, chunks = load_corpus(config.library)
    if not docs:
        raise ValueError("知识库为空，无法建立检索索引")
    fp = fingerprint(docs)
    model_fp = model_fingerprint(config.model)
    signature = f"{VERSION}:{fp}:{len(chunks)}:{model_fp}"
    old = {}
    try:
        old = json.loads((store / "manifest.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        pass
    if (old.get("signature") == signature
            and all((store / name).is_file() for name in ("vectors.npy", "documents.json", "chunks.json"))
            and all(hashlib.sha256((store / name).read_bytes()).hexdigest() == old.get(key)
                    for name, key in (("vectors.npy", "vectorSHA256"),
                                      ("documents.json", "documentSHA256"),
                                      ("chunks.json", "chunkSHA256")))):
        print("Index unchanged; vector rebuild not needed.", flush=True)
        return old
    print(f"Corpus: {len(docs)} files; {len(chunks)} chunks. Loading model.", flush=True)
    model = make_model(config)
    model.max_seq_length = 512
    dim = model.get_sentence_embedding_dimension()
    progress_file = store / "build-progress.json"
    partial_file = store / "vectors.partial.npy"
    progress = {}
    if progress_file.exists():
        try:
            progress = json.loads(progress_file.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            progress = {}
    done = progress.get("done", 0)
    resume = (progress.get("signature") == signature and partial_file.exists()
              and type(done) is int and 0 <= done <= len(chunks))
    if resume:
        try:
            vectors = np.lib.format.open_memmap(partial_file, mode="r+")
            resume = vectors.shape == (len(chunks), dim) and vectors.dtype == np.float32
            if not resume:
                del vectors
        except (ValueError, OSError):
            resume = False
    if not resume:
        done = 0
        vectors = np.lib.format.open_memmap(partial_file, mode="w+", dtype="float32",
                                           shape=(len(chunks), dim))
    start = time.perf_counter()
    for offset in range(done, len(chunks), 128):
        batch = [embed_text(docs[c["doc"]], c) for c in chunks[offset:offset+128]]
        vectors[offset:offset+len(batch)] = model.encode(batch, batch_size=24, normalize_embeddings=True, show_progress_bar=False)
        vectors.flush()
        progress_file.write_text(json.dumps({"signature": signature, "done": offset+len(batch)}), encoding="utf-8")
        print(f"Encoded {offset+len(batch)}/{len(chunks)} ({time.perf_counter()-start:.1f}s)", flush=True)
    del vectors
    if fingerprint(scan_documents(config.library)) != fp:
        raise CorpusChanged("知识库在构建期间发生变化，请重新构建")
    if model_fingerprint(config.model) != model_fp:
        raise CorpusChanged("模型在构建期间发生变化，请重新构建")
    partial_file.replace(store / "vectors.npy")
    (store / "documents.json").write_text(json.dumps(docs, ensure_ascii=False), encoding="utf-8")
    (store / "chunks.json").write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
    manifest = {"version": VERSION, "signature": signature, "fingerprint": fp, "files": len(docs),
                "textFiles": sum(d["textIndexed"] for d in docs), "chunks": len(chunks), "dimensions": dim,
                "model": config.model.name, "modelFingerprint": model_fp,
                "queryPrefix": QUERY_PREFIX, "normalized": True, "created": time.time(),
                "vectorSHA256": hashlib.sha256((store/"vectors.npy").read_bytes()).hexdigest(),
                "documentSHA256": hashlib.sha256((store/"documents.json").read_bytes()).hexdigest(),
                "chunkSHA256": hashlib.sha256((store/"chunks.json").read_bytes()).hexdigest()}
    # Publish the manifest last: incomplete builds never look ready.
    pending_manifest = store / "manifest.pending.json"
    pending_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    pending_manifest.replace(store / "manifest.json")
    progress_file.unlink(missing_ok=True)
    print(json.dumps(manifest), flush=True)
    return manifest


class Engine:
    def __init__(self, config=None):
        self.settings = config or Config.from_env()
        self.settings.validate()
        numeric_dependencies()
        store = self.settings.store
        self.manifest = json.loads((store/"manifest.json").read_text(encoding="utf-8"))
        if self.manifest.get("version") != VERSION:
            raise RuntimeError("索引版本不匹配，请重新构建")
        for name, key in (("vectors.npy", "vectorSHA256"), ("documents.json", "documentSHA256"),
                          ("chunks.json", "chunkSHA256")):
            if hashlib.sha256((store/name).read_bytes()).hexdigest() != self.manifest.get(key):
                raise RuntimeError("索引校验失败，请重新构建")
        self.docs = json.loads((store/"documents.json").read_text(encoding="utf-8"))
        self.chunks = json.loads((store/"chunks.json").read_text(encoding="utf-8"))
        self.vectors = np.load(store/"vectors.npy", mmap_mode="r", allow_pickle=False)
        if (self.vectors.shape != (len(self.chunks), self.manifest["dimensions"])
                or self.vectors.dtype != np.float32
                or len(self.docs) != self.manifest["files"]
                or len(self.chunks) != self.manifest["chunks"]
                or fingerprint(self.docs) != self.manifest["fingerprint"]):
            raise RuntimeError("索引结构不匹配，请重新构建")
        self.library = self.settings.library
        self.index_stale = False
        self.verify_snapshot()
        if model_fingerprint(self.settings.model) != self.manifest.get("modelFingerprint"):
            raise RuntimeError("本地模型与索引不一致，请重新构建")
        self.model = make_model(self.settings)
        self.model.max_seq_length = 512
        texts = [embed_text(self.docs[c["doc"]], c) for c in self.chunks]
        self.vectorizer = CountVectorizer(analyzer=terms, max_features=60000, dtype=np.float32)
        counts = self.vectorizer.fit_transform(texts).tocsr()
        lengths = np.asarray(counts.sum(axis=1)).ravel()
        df = np.asarray((counts > 0).sum(axis=0)).ravel()
        idf = np.log(1 + (counts.shape[0] - df + .5) / (df + .5))
        rows = np.repeat(np.arange(counts.shape[0]), np.diff(counts.indptr))
        k1, b = 1.2, .75
        counts.data = counts.data*(k1+1)/(counts.data+k1*(1-b+b*lengths[rows]/max(lengths.mean(), 1)))*idf[counts.indices]
        self.bm25 = counts
        self.doc_index = np.asarray([c["doc"] for c in self.chunks])
        self.doc_text = [""] * len(self.docs)
        for i, d in enumerate(self.docs):
            raw = self.read_source(d)
            self.doc_text[i] = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n") if d["textIndexed"] else ""
        self.doc_by_id = {d["id"]: i for i, d in enumerate(self.docs)}
        self.answer_passages = [passages(text) for text in self.doc_text]
        self.doc_search = [norm(d["path"]+"\n"+self.doc_text[i]) for i, d in enumerate(self.docs)]
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.started = time.time()
        self.requests = 0
        self.signal_cache = OrderedDict()
        self.signal_lock = threading.Lock()
        # Fixed, reviewable defaults only. No evaluation labels or learned weights.
        self.config = dict(DEFAULT_RANKING)

    def read_source(self, doc):
        data = read_checked(self.library, doc["path"])
        if hashlib.sha256(data).hexdigest() != doc["sha256"]:
            self.index_stale = True
            raise CorpusChanged("来源文件已变化，请重建索引")
        return data

    def verify_snapshot(self):
        if self.index_stale:
            raise CorpusChanged("资料已变化，请重建索引并重启")
        try:
            if fingerprint(scan_documents(self.library)) != self.manifest["fingerprint"]:
                raise CorpusChanged("知识库已变化，请重建索引并重启")
        except (CorpusChanged, OSError):
            self.index_stale = True
            raise

    def encoded_query(self, q):
        with self.lock:
            if q in self.cache:
                self.cache.move_to_end(q)
                return self.cache[q]
            vec = self.model.encode([QUERY_PREFIX+q], normalize_embeddings=True, show_progress_bar=False)[0]
            self.cache[q] = vec
            if len(self.cache)>512:
                self.cache.popitem(last=False)
            return vec

    def signals(self, q):
        with self.signal_lock:
            cached = self.signal_cache.get(q)
            if cached is not None:
                self.signal_cache.move_to_end(q)
                return cached
        a = analyze(q)
        vec = self.encoded_query(q)
        dense = np.asarray(self.vectors @ vec)
        tokens = self.vectorizer.transform([a["expanded"]])
        tokens.data[:] = 1
        lexical = (self.bm25 @ tokens.T).toarray().ravel()
        out = (a, dense, lexical)
        with self.signal_lock:
            self.signal_cache[q] = out
            if len(self.signal_cache)>128:
                self.signal_cache.popitem(last=False)
        return out

    def search(self, q, top_k=10, strategy="hybrid"):
        start = time.perf_counter()
        validate_query(q, top_k, strategy)
        self.verify_snapshot()
        self.requests += 1
        cfg = self.config
        a = analyze(q)
        if strategy == "exact":
            words = [norm(w) for w in q.split("|") if norm(w)]
            candidates = [(i, 1.0, None, None) for i, s in enumerate(self.doc_search) if any(w in s for w in words)]
            results = []
            for di, score, _, _ in candidates[:top_k]:
                offset = self.doc_text[di].lower().find(q.lower())
                results.append(self.result(di, None, score, None, None, offset=max(0, offset-80)))
            return self.package(q, a, strategy, results, len(candidates), start)
        a, dense, lexical = self.signals(q)
        if strategy == "vector":
            scores = dense.copy()
        elif strategy == "lexical":
            scores = lexical / max(float(lexical.max()), 1e-6)
        else:
            alpha = cfg.get("denseWeight", .55)
            # Scores are not probabilities. Both channels retain actual matching evidence.
            scores = alpha*dense + (1-alpha)*lexical/max(float(lexical.max()), 1e-6)
            doc_bonus = np.zeros(len(self.docs), dtype=np.float32)
            support = service_intent(q)
            for di, d in enumerate(self.docs):
                p = d["path"]
                pn = norm(p)
                identities_here = set(d["entities"])
                query_ids = set(a["entities"])
                if query_ids and identities_here:
                    doc_bonus[di] += cfg.get("entityWeight", .24) if query_ids & identities_here else -cfg.get("mismatchPenalty", .8)
                if p.startswith("P1-"):
                    doc_bonus[di] += .025
                if support:
                    doc_bonus[di] += .15 if p.startswith("P7-") else -.4
                    if p.startswith("P7-") and re.search(SERVICE_INTENTS[support][1], d["title"]):
                        doc_bonus[di] += .4
                for topic in a["topics"]:
                    _, words, card = TOPICS[topic]
                    if card in p:
                        doc_bonus[di] += cfg.get("topicWeight", .16)
                    if topic == "price" and "08-官方公开价格" in p:
                        doc_bonus[di] += cfg.get("topicWeight", .16)
                    if topic == "memory" and "销售配置" in p:
                        doc_bonus[di] += .08
                    if any(norm(word) in pn for word in words):
                        doc_bonus[di] += .02
                for platform in a["platforms"]:
                    if norm(platform) in pn:
                        doc_bonus[di] += .12
                        if "平台模板" in p:
                            doc_bonus[di] += .14
                if re.search(r"图片|配图|主视觉|素材图", q):
                    if not d["textIndexed"]:
                        doc_bonus[di] += .13
                elif not d["textIndexed"]:
                    doc_bonus[di] -= .15
            scores += doc_bonus[self.doc_index]
        order = np.argsort(-scores, kind="stable")
        seen, results = set(), []
        for ci in order:
            di = int(self.doc_index[ci])
            if di in seen:
                continue
            seen.add(di)
            results.append(self.result(di, int(ci), float(scores[ci]), float(dense[ci]), float(lexical[ci])))
            if len(results) == top_k:
                break
        out = self.package(q, a, strategy, results, len(self.docs), start)
        if results:
            top = results[0]
            query_entities = set(a["entities"])
            top_entities = set(top["entities"])
            model_ok = not query_entities or bool(query_entities & top_entities)
            out["evidenceSufficient"] = bool(top["denseScore"] >= cfg.get("answerThreshold", .53) and model_ok)
        return out

    def result(self, di, ci, score, dense, lexical, offset=0):
        d = self.docs[di]
        c = self.chunks[ci] if ci is not None else {"text": self.doc_text[di][offset:offset+420],
               "start": offset, "end": min(offset+420, len(self.doc_text[di])),
               "line": self.doc_text[di].count("\n", 0, offset)+1,
               "lineEnd": self.doc_text[di].count("\n", 0, offset+420)+1}
        return {**d, "source": "本地已下载知识库", "score": round(score, 6),
                "denseScore": round(dense, 6) if dense is not None else None,
                "lexicalScore": round(lexical, 6) if lexical is not None else None,
                "preview": c["text"], "chunkId": f'{d["id"]}:{c["start"]}',
                "start": c["start"], "end": c["end"], "line": c["line"], "lineEnd": c["lineEnd"],
                "documentUrl": "/document?id="+d["id"], "imageContentAnalyzed": False}

    def package(self, q, a, strategy, results, count, start):
        return {"query": q, "strategy": strategy, "analysis": a, "results": results,
                "totalCandidates": count, "returned": len(results), "latencyMs": round((time.perf_counter()-start)*1000, 2),
                "model": self.manifest["model"], "indexFingerprint": self.manifest["fingerprint"],
                # search() has verified every source byte for this request. The
                # adapter can validate this binding without a second full scan.
                "verifiedSnapshot": {
                    "service": "ima-local-rag", "apiVersion": 2,
                    "files": self.manifest["files"], "fingerprint": self.manifest["fingerprint"],
                    "ready": not self.index_stale, "indexStale": self.index_stale,
                    "verification": "full-content-per-request",
                },
                "onlineUsed": False, "semanticRecallGuaranteed": False, "evidenceSufficient": False}

    def answer(self, q, top_k=5):
        return make_answer(self, q, top_k)

    def health(self):
        try:
            self.verify_snapshot()
        except (CorpusChanged, OSError):
            self.index_stale = True
        return {"service": "ima-local-rag", **self.manifest, "status": "degraded" if self.index_stale else "ok",
                "apiVersion": 2, "ready": not self.index_stale, "indexStale": self.index_stale,
                "uptimeSeconds": round(time.time()-self.started), "requests": self.requests,
                "embeddingInference": "local-cpu", "queryCache": len(self.cache),
                "config": self.config, "semanticRecallGuaranteed": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "query"])
    parser.add_argument("--q")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--strategy", choices=["exact", "lexical", "vector", "hybrid"], default="hybrid")
    args = parser.parse_args()
    if args.command == "build":
        build()
    else:
        if not args.q:
            parser.error("query 需要 --q")
        print(json.dumps(Engine().search(args.q, args.top_k, args.strategy), ensure_ascii=False, indent=2))
