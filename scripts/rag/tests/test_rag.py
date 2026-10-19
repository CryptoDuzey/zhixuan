"""Synthetic regression tests; HTTP cases bind only random loopback ports."""
from __future__ import annotations

from contextlib import redirect_stdout
from email.message import Message
import hashlib
from http.client import HTTPConnection
import importlib
import io
import json
import logging
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlencode

RAG_DIR = Path(__file__).resolve().parents[1]
# Locate the checkout independently of rag_config's parent arithmetic.
# Both markers must exist; an incorrect PROJECT_ROOT cannot move the expected
# paths along with the implementation and make these assertions pass.
EXPECTED_REPO_ROOT = next(
    parent for parent in Path(__file__).resolve().parents
    if (parent / "app/package.json").is_file()
    and (parent / "scripts/knowledge-server.mjs").is_file()
)
EXPECTED_ADAPTER = EXPECTED_REPO_ROOT / "scripts/knowledge-server.mjs"
sys.path.insert(0, str(RAG_DIR))

from rag_answer import clean_quote, fact_signature, make_answer, passages
from rag_config import Config, DEFAULT_STORE, PROJECT_ROOT, ServerConfig
from rag_corpus import (CorpusChanged, fingerprint, model_fingerprint, read_checked,
                        scan_documents)
import rag_engine
from rag_engine import Engine, load_corpus
from rag_protocol import loopback_address, parse_request, validate_query
from rag_server import Handler, HealthHandler, Runtime, Server, error_body


class OfflineCase(unittest.TestCase):
    def setUp(self):
        # Fail immediately if a future test accidentally attempts any networking.
        self.addCleanup(patch.stopall)
        patch("socket.socket", side_effect=AssertionError("offline tests prohibit sockets")).start()
        self.temp = tempfile.TemporaryDirectory(prefix="zhixuan-rag-offline-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / "kb"
        self.model = self.root / "model"
        self.library.mkdir()
        self.model.mkdir()
        (self.model / "config.json").write_text('{"fixture": true}', encoding="utf-8")
        self.config = Config(self.library, self.root / "store", self.model)

    def write(self, path, data):
        target = self.library / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
        return target


class ConfigurationTests(OfflineCase):
    def env(self, **overrides):
        return {"ZHIXUAN_KB_DIR": str(self.library),
                "ZHIXUAN_EMBEDDING_MODEL": str(self.model), **overrides}

    def test_required_directories_and_no_implicit_writes(self):
        for missing in ("ZHIXUAN_KB_DIR", "ZHIXUAN_EMBEDDING_MODEL"):
            env = self.env()
            del env[missing]
            with self.assertRaisesRegex(ValueError, missing):
                Config.from_env(env)
        config = Config.from_env(self.env())
        self.assertEqual(config.store, EXPECTED_REPO_ROOT / "app/data/private/rag")
        self.assertEqual(config.store, DEFAULT_STORE)
        self.assertFalse(self.config.store.exists())

    def test_repository_store_and_adapter_have_independent_expected_locations(self):
        import rag_config

        config_file = Path(rag_config.__file__).resolve()
        self.assertTrue(EXPECTED_REPO_ROOT.is_absolute())
        self.assertEqual(PROJECT_ROOT, EXPECTED_REPO_ROOT)
        self.assertEqual(
            config_file.relative_to(EXPECTED_REPO_ROOT).as_posix(),
            "scripts/rag/rag_config.py",
        )
        self.assertEqual(
            DEFAULT_STORE.relative_to(EXPECTED_REPO_ROOT).as_posix(),
            "app/data/private/rag",
        )
        adapter = PROJECT_ROOT / "scripts/knowledge-server.mjs"
        self.assertEqual(adapter, EXPECTED_ADAPTER)
        self.assertTrue(adapter.is_file())
        self.assertEqual(
            adapter.relative_to(EXPECTED_REPO_ROOT).as_posix(),
            "scripts/knowledge-server.mjs",
        )

    def test_default_store_stays_at_repository_when_working_directory_changes(self):
        original = Path.cwd()
        try:
            os.chdir(self.root)
            config = Config.from_env(self.env())
        finally:
            os.chdir(original)
        self.assertEqual(config.store, EXPECTED_REPO_ROOT / "app/data/private/rag")
        self.assertFalse((self.root / "app/data/private/rag").exists())

    def test_store_path_is_resolved_and_separate(self):
        config = Config.from_env(self.env(ZHIXUAN_RAG_STORE=str(self.root / "local cache")))
        self.assertEqual(config.store, (self.root / "local cache").resolve())
        for store in ("", str(self.library / "index"), str(self.model / "index"),
                      str(self.root), str(RAG_DIR / "index")):
            with self.subTest(store=store), self.assertRaises(ValueError):
                Config.from_env(self.env(ZHIXUAN_RAG_STORE=store))

    def test_missing_or_file_directory_is_rejected(self):
        for name in ("ZHIXUAN_KB_DIR", "ZHIXUAN_EMBEDDING_MODEL"):
            for path in (self.root / "missing", self.model / "config.json"):
                with self.subTest(name=name, path=path), self.assertRaises(ValueError):
                    Config.from_env(self.env(**{name: str(path)}))

    def test_port_limits_and_collision(self):
        self.assertEqual(ServerConfig.from_env({}), ServerConfig())
        for key, values in {
            "IMA_RAG_PORT": ["0", "65536", "x", "-1", "", " 8766", "８７６６"],
            "IMA_RAG_HEALTH_PORT": ["0", "65536", "8766"],
            "IMA_RAG_MAX_WORKERS": ["0", "33", "1.5"],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    ServerConfig.from_env({key: value})

    def test_import_never_loads_dependencies_or_opens_listeners(self):
        real_import = __import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"numpy", "sklearn", "scipy", "torch", "sentence_transformers"}:
                raise AssertionError(f"unexpected optional dependency: {name}")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=guarded), \
                patch("logging.handlers.RotatingFileHandler", side_effect=AssertionError("log write")):
            importlib.reload(rag_engine)
            importlib.reload(importlib.import_module("rag_server"))
        self.assertFalse(self.config.store.exists())

    def test_model_loader_forces_offline_local_only_and_disables_remote_code(self):
        torch = types.ModuleType("torch")
        torch.set_num_threads = Mock()
        transformers = types.ModuleType("sentence_transformers")
        transformers.SentenceTransformer = Mock()
        with patch.dict(sys.modules, {"torch": torch, "sentence_transformers": transformers}), \
                patch.dict(os.environ, {"HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0"}):
            rag_engine.make_model(self.config)
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
        transformers.SentenceTransformer.assert_called_once_with(
            str(self.model), device="cpu", local_files_only=True, trust_remote_code=False)
        torch.set_num_threads.assert_called_once_with(4)

    def test_release_contains_only_source_docs_and_synthetic_tests(self):
        allowed = {".py", ".md", ".txt"}
        for file in RAG_DIR.rglob("*"):
            if not file.is_file() or "__pycache__" in file.parts:
                continue
            self.assertIn(file.suffix, allowed, str(file))
            if file.parent == RAG_DIR and file.suffix == ".py":
                text = file.read_text(encoding="utf-8")
                self.assertNotRegex(text, r"[A-Za-z]:[/\\]|/Users/|/home/")
                self.assertNotRegex(text, r"(?i)(?:api[_-]?key|access[_-]?token|secret)\s*=\s*['\"][^'\"]+")
                self.assertNotRegex(text, r"rag-evaluation|evaluation-set|rag-config\.json")


class ProtocolTests(OfflineCase):
    def test_valid_routes_and_defaults(self):
        self.assertEqual(parse_request("/search?q=sample"), ("/search", "sample", 10, "hybrid"))
        self.assertEqual(parse_request("/answer?q=sample"), ("/answer", "sample", 5, "hybrid"))
        for strategy in ("exact", "lexical", "vector", "hybrid"):
            self.assertEqual(parse_request(f"/search?q=x&top_k=50&strategy={strategy}")[-2:], (50, strategy))

    def test_invalid_inputs_rejected_before_engine(self):
        bad = [
            "/search", "/search?q=", "/search?q=%20", "/search?q=x&q=y",
            "/search?q=x&top_k=1&top_k=2", "/search?q=x&x=y",
            "/search?q=x&top_k=0", "/search?q=x&top_k=51", "/search?q=x&top_k=1.0",
            "/search?q=x&top_k=-1", "/search?q=x&strategy=unknown",
            "/answer?q=x&strategy=hybrid", "/search?q=%00", "/search?q=%7F",
            "/search?q=%GG", "/search?q=%FF", "/search?q=" + "x" * 1001,
            "http://127.0.0.1/search?q=x", "/search?q=x#secret",
        ]
        for target in bad:
            with self.subTest(target=target[:90]), self.assertRaises(ValueError):
                parse_request(target)
        for value in (True, 1.1, "5", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_query("sample", value, "hybrid")

    def test_only_literal_loopback_can_bind(self):
        self.assertEqual(loopback_address(("127.0.0.1", 8766)), ("127.0.0.1", 8766))
        for host in ("0.0.0.0", "::", "::1", "localhost", "127.0.0.2", "example.test"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                loopback_address((host, 8766))
        for port in (0, 65536, True, "8766"):
            with self.subTest(port=port), self.assertRaises(ValueError):
                loopback_address(("127.0.0.1", port))

    def handler(self, path, engine=None, header="request-test-123"):
        handler = Handler.__new__(Handler)
        handler.path = path
        handler.headers = Message()
        handler.headers["X-Request-ID"] = header
        engine = engine or types.SimpleNamespace(search=Mock(return_value={"results": []}))
        logger = logging.Logger("offline-rag")
        logger.addHandler(logging.NullHandler())
        handler.server = types.SimpleNamespace(runtime=Runtime(engine, logger), max_workers=8)
        output = {}

        def send(code, body, headers=None):
            handler.response_status = code
            handler.response_reason = body.get("reasonCode")
            output.update(code=code, body=body, headers=headers)

        handler.send = send
        return handler, engine, output

    def test_handler_dispatch_request_ids_and_error_shapes(self):
        handler, engine, out = self.handler("/search?q=sample&top_k=2&strategy=exact")
        handler.do_GET()
        engine.search.assert_called_once_with("sample", 2, "exact")
        self.assertEqual(out["code"], 200)
        self.assertEqual(handler.request_id, "request-test-123")
        self.assertEqual(handler.server.runtime.stats["completed"], 1)
        for route in ("/search?q=x&q=y", "/answer?q=x&strategy=hybrid"):
            handler, engine, out = self.handler(route, header="bad")
            handler.do_GET()
            self.assertEqual(out["code"], 400)
            engine.search.assert_not_called()
            self.assertRegex(handler.request_id, r"^[a-f0-9]{32}$")
            self.assertTrue(out["body"]["abstained"])
            self.assertEqual(out["body"]["citations"], [])

    def test_handler_fail_closed_and_no_exception_details(self):
        for error, code, reason in (
            (CorpusChanged("sensitive path"), 409, "INDEX_STALE"),
            (RuntimeError("sensitive path"), 500, "INTERNAL_ERROR"),
        ):
            handler, _, out = self.handler("/search?q=sample",
                                          types.SimpleNamespace(search=Mock(side_effect=error)))
            handler.do_GET()
            self.assertEqual((out["code"], out["body"]["reasonCode"]), (code, reason))
            self.assertNotIn("sensitive path", json.dumps(out))
        handler, _, out = self.handler("/missing")
        handler.do_GET()
        self.assertEqual(out["code"], 404)
        handler, _, out = self.handler("/search?q=" + "a" * 16384)
        handler.do_GET()
        self.assertEqual(out["code"], 414)
        handler, _, out = self.handler("/answer?q=x")
        handler.do_POST()
        self.assertEqual(out["code"], 405)

    def test_answer_dispatch_and_health_while_query_slots_full(self):
        engine = types.SimpleNamespace(answer=Mock(return_value={"answer": ""}),
                                       health=Mock(return_value={"service": "ima-local-rag", "ready": True}))
        handler, _, out = self.handler("/answer?q=sample", engine)
        handler.do_GET()
        engine.answer.assert_called_once_with("sample", 5)
        handler, _, out = self.handler("/health", engine)
        handler.server.runtime.stats["active"] = 8
        health = HealthHandler.__new__(HealthHandler)
        health.__dict__.update(handler.__dict__)
        health.server.query_server = handler.server
        health.do_GET()
        self.assertEqual(out["code"], 200)
        self.assertTrue(out["body"]["querySaturated"])
        self.assertEqual(out["body"]["probeScope"], "process_only")

    def test_wire_headers_and_body_without_any_socket(self):
        handler = Handler.__new__(Handler)
        handler.request_id = "request-test-123"
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.send(503, error_body("BUSY", "繁忙", "ignored", True), {"Retry-After": "1"})
        body = json.loads(handler.wfile.getvalue())
        headers = dict(call.args for call in handler.send_header.call_args_list)
        self.assertEqual(body["requestId"], handler.request_id)
        self.assertEqual(int(headers["Content-Length"]), len(handler.wfile.getvalue()))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Retry-After"], "1")
        self.assertTrue(handler.close_connection)


class HTTPQueryBoundaryTests(unittest.TestCase):
    """Exercise the real server/handler/parser with only generated local data."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zhixuan-rag-http-")
        self.addCleanup(self.temp.cleanup)
        self.library = Path(self.temp.name)
        self.document = self.library / "fictional.txt"
        self.document.write_text("虚构测试资料，仅验证传输边界。", encoding="utf-8")
        self.calls = []

        def result(query, top_k, strategy="hybrid"):
            self.calls.append((query, top_k, strategy))
            return {"query": query, "strategy": strategy, "top_k": top_k,
                    "fixture": self.document.read_text(encoding="utf-8")}

        engine = types.SimpleNamespace(
            search=result, answer=result,
            health=lambda: {"service": "ima-local-rag", "ready": True})
        logger = logging.Logger("synthetic-http-rag")
        logger.addHandler(logging.NullHandler())
        # Production binding deliberately disallows port 0. Discover an unused
        # ephemeral port, retry a bind race, and never use production ports.
        for attempt in range(10):
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            if port in {3100, 8765, 8766, 8767}:
                continue
            try:
                self.server = Server(("127.0.0.1", port), Handler, Runtime(engine, logger), max_workers=1)
                break
            except OSError:
                if attempt == 9:
                    raise
        else:
            self.fail("No safe temporary port available")
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())

    def get(self, target):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request("GET", target, headers={"X-Request-ID": "boundary-http-123"})
            response = connection.getresponse()
            payload = response.read()
            self.assertEqual(int(response.getheader("Content-Length")), len(payload))
            body = json.loads(payload)
            self.assertEqual(response.getheader("X-Request-ID"), body["requestId"])
            return response.status, body, dict(response.getheaders())
        finally:
            connection.close()

    def test_1000_chinese_and_supplementary_characters_reach_both_routes_intact(self):
        for query in ("中" * 1000, "🧪" * 1000, "𠀀" * 1000, "中🧪 " * 333 + "文"):
            self.assertEqual(len(query), 1000)
            for route in ("/search", "/answer"):
                with self.subTest(route=route, character=query[0]):
                    args = {"q": query, "top_k": 50}
                    if route == "/search":
                        args["strategy"] = "hybrid"
                    target = route + "?" + urlencode(args)
                    if " " not in query:
                        self.assertGreater(len(target.encode()), 8192)
                    status, body, _ = self.get(target)
                    self.assertEqual(status, 200)
                    self.assertEqual(body["query"], query)
                    self.assertEqual(self.calls[-1], (query, 50, "hybrid"))
                    self.assertEqual(body["fixture"], self.document.read_text(encoding="utf-8"))

    def test_1001_characters_still_rejected_before_engine_and_valid_request_recovers(self):
        for query in ("中" * 1001, "🧪" * 1001):
            for route in ("/search", "/answer"):
                with self.subTest(route=route, character=query[0]):
                    status, body, _ = self.get(route + "?" + urlencode({"q": query}))
                    self.assertEqual(status, 400)
                    self.assertEqual(body["reasonCode"], "INVALID_ARGUMENT")
                    self.assertTrue(body["abstained"])
                    self.assertEqual(body["claims"], [])
                    self.assertEqual(body["citations"], [])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.get("/search?q=fixture")[0], 200)
        self.assertEqual(len(self.calls), 1)

    def test_url_byte_limit_is_inclusive_16384_and_reported_in_health(self):
        # Unknown route isolates transport length from the independent q limit.
        prefix = "/missing?q="
        for length, expected in ((16384, 404), (16385, 414)):
            target = prefix + "a" * (length - len(prefix))
            self.assertEqual(len(target.encode()), length)
            status, body, _ = self.get(target)
            self.assertEqual(status, expected)
            self.assertEqual(body["reasonCode"], "NOT_FOUND" if expected == 404 else "REQUEST_TOO_LARGE")
        self.assertEqual(self.calls, [])
        status, body, _ = self.get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["limits"]["maxUrlBytes"], 16384)

    def test_long_query_when_busy_gets_complete_503_then_recovers(self):
        # Reserve the sole worker without starting an unrelated blocking query.
        self.assertTrue(self.server.slots.acquire(blocking=False))
        try:
            target = "/search?" + urlencode({"q": "🧪" * 1000})
            status, body, headers = self.get(target)
            self.assertEqual(status, 503)
            self.assertEqual(body["reasonCode"], "BUSY")
            self.assertEqual(headers["Retry-After"], "1")
            self.assertTrue(body["retryable"])
            self.assertEqual(self.calls, [])
        finally:
            self.server.slots.release()
        self.assertEqual(self.get(target)[0], 200)
        self.assertEqual(len(self.calls), 1)


class CorpusTests(OfflineCase):
    def test_complete_fingerprint_ignores_input_order_and_binds_all_bytes(self):
        self.write("notes.markdown", "虚构离线资料")
        image = self.write("nested/picture.bin", b"\x00\x01\xfe")
        self.write("empty.txt", "")
        self.write("invalid.txt", b"\xff\xfe")
        before = scan_documents(self.library)
        self.assertEqual(len(before), 4)
        self.assertEqual(fingerprint(before), fingerprint(list(reversed(before))))
        docs, chunks = load_corpus(self.library)
        self.assertEqual(fingerprint(docs), fingerprint(before))
        self.assertEqual(next(d for d in docs if d["path"] == "notes.markdown")["textIndexed"], True)
        for path in ("invalid.txt", "empty.txt"):
            di = next(i for i, d in enumerate(docs) if d["path"] == path)
            self.assertFalse(docs[di]["textIndexed"])
            self.assertEqual(next(c for c in chunks if c["doc"] == di)["text"], "")
        image.write_bytes(b"\x00\x02\xfe")
        self.assertNotEqual(fingerprint(scan_documents(self.library)), fingerprint(before))
        image.unlink()
        self.assertNotEqual(fingerprint(scan_documents(self.library)), fingerprint(before))

    def test_chunk_offsets_cover_every_original_character(self):
        raw = ("虚构😀测试段落\r\n" * 160) + "结束\r"
        self.write("chunk.md", raw)
        docs, chunks = load_corpus(self.library)
        coverage = set()
        for chunk in chunks:
            self.assertEqual(raw[chunk["start"]:chunk["end"]], chunk["text"])
            coverage.update(range(chunk["start"], chunk["end"]))
        self.assertEqual(coverage, set(range(len(raw))))

    def test_unsafe_relative_paths_cannot_read_outside_corpus(self):
        self.write("ok.txt", "safe")
        for relative in ("../model/config.json", "/etc/passwd", "C:/file", r"..\secret", "a/../ok.txt"):
            with self.subTest(relative=relative), self.assertRaises(CorpusChanged):
                read_checked(self.library, relative)
        self.assertEqual(read_checked(self.library, "ok.txt"), b"safe")

    def test_windows_ctime_api_difference_is_not_a_false_change(self):
        self.write("ok.txt", "safe")
        original_fstat = os.fstat

        def differing_ctime(descriptor):
            actual = original_fstat(descriptor)
            return types.SimpleNamespace(
                st_dev=actual.st_dev, st_ino=actual.st_ino, st_size=actual.st_size,
                st_mtime_ns=actual.st_mtime_ns, st_ctime_ns=actual.st_ctime_ns + 123456)

        with patch("rag_corpus.os.fstat", side_effect=differing_ctime):
            self.assertEqual(read_checked(self.library, "ok.txt"), b"safe")

    def test_model_links_fail_explicitly_without_requiring_link_permissions(self):
        with patch("rag_corpus.is_link", return_value=True), self.assertRaisesRegex(ValueError, "模型"):
            model_fingerprint(self.model)

    def test_replaced_source_link_is_rejected_without_requiring_link_permissions(self):
        self.write("ok.txt", "safe")
        with patch("rag_corpus.is_link", side_effect=lambda p: p.name == "ok.txt"), \
                self.assertRaises(CorpusChanged):
            read_checked(self.library, "ok.txt")

    def test_links_are_skipped_and_replaced_sources_rejected(self):
        self.write("ok.txt", "safe")
        link = self.library / "link"
        try:
            link.symlink_to(self.model, target_is_directory=True)
        except OSError:
            self.skipTest("当前系统未开放创建符号链接权限")
        self.assertEqual([d["path"] for d in scan_documents(self.library)], ["ok.txt"])
        with self.assertRaises(CorpusChanged):
            read_checked(self.library, "link/config.json")

    def test_snapshot_rejects_additions_deletions_and_binary_edits(self):
        for change in ("add", "delete", "binary"):
            self.write("base.md", "synthetic fixture")
            binary = self.write("image.bin", b"\x00")
            engine = Engine.__new__(Engine)
            engine.library = self.library
            engine.index_stale = False
            engine.manifest = {"fingerprint": fingerprint(scan_documents(self.library))}
            engine.verify_snapshot()
            if change == "add":
                self.write("added.txt", "added")
            elif change == "delete":
                (self.library / "base.md").unlink()
            else:
                binary.write_bytes(b"\x01")
            with self.subTest(change=change), self.assertRaises(CorpusChanged):
                engine.verify_snapshot()
            self.assertTrue(engine.index_stale)
            (self.library / "added.txt").unlink(missing_ok=True)


class AnswerFixtureCase(OfflineCase):
    def engine(self, texts):
        docs, results = [], []
        for i, text in enumerate(texts):
            # Fictional facts under the existing card schema; no production data.
            path = f"P1-产品参数库/06-型号检索卡/HUAWEI MateBook Pro S/{i:02d}-虚构测试.md"
            file = self.write(path, text)
            doc = dict(id=str(i), path=path, title=file.name,
                       sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                       entities=["pros"], textIndexed=True)
            docs.append(doc)
            results.append({**doc, "denseScore": .95})
        return types.SimpleNamespace(
            docs=docs, doc_by_id={d["id"]: i for i, d in enumerate(docs)},
            doc_text=texts, answer_passages=[passages(t) for t in texts],
            config={"answerThreshold": .53}, library=self.library, index_stale=False,
            search=lambda q, k, strategy: dict(
                query=q, strategy=strategy, indexFingerprint=fingerprint(docs), onlineUsed=False,
                analysis=dict(entities=["pros"], topics=[], platforms=[], ambiguousModel=False,
                              unsupportedReasons=[]), results=results, returned=len(results)),
        )


class AnswerTests(AnswerFixtureCase):
    def test_whole_qualifier_citations_and_conditions_are_verbatim(self):
        text = "## 已确认事实\n\n- 内存7 GB，仅限虚构测试款。\n\n## 限定条件\n\n- 禁止用于产品事实说明。\n"
        result = make_answer(self.engine([text]), "ProS内存多大", 5)
        self.assertEqual(result["status"], "answered")
        self.assertFalse(result["generationModelUsed"])
        self.assertIn("仅限虚构测试款", result["answer"])
        self.assertEqual(result["conditions"][0]["text"], "禁止用于产品事实说明。")
        citations = {c["number"]: c for c in result["citations"]}
        for c in result["citations"]:
            self.assertEqual(text[c["start"]:c["end"]], c["preview"])
        for claim in result["claims"] + result["conditions"]:
            self.assertEqual(claim["text"], clean_quote(citations[claim["citationIds"][0]]["preview"]))

    def test_conflicts_incomplete_requests_and_unproven_numbers_abstain(self):
        cases = [
            (["## 已确认事实\n\n- 内存7 GB。\n", "## 已确认事实\n\n- 内存11 GB。\n"],
             "ProS内存多大", "SOURCE_CONFLICT"),
            (["## 已确认事实\n\n- 内存7 GB。\n"], "ProS内存和颜色有哪些", "INCOMPLETE_EVIDENCE"),
            (["## 已确认事实\n\n- 内存7 GB。\n"], "ProS内存是99GB吗", "PREMISE_NOT_VERIFIED"),
        ]
        for texts, q, reason in cases:
            with self.subTest(reason=reason):
                result = make_answer(self.engine(texts), q, 5)
                self.assertEqual(result["reasonCode"], reason)
                self.assertEqual(result["citations"], [])
                self.assertEqual(result["claims"], [])
                self.assertFalse(result["evidenceSufficient"])

    def test_changed_source_refuses_answer(self):
        engine = self.engine(["## 已确认事实\n\n- 内存7 GB。\n"])
        self.write(engine.docs[0]["path"], "changed")
        result = make_answer(engine, "ProS内存多大", 5)
        self.assertEqual(result["reasonCode"], "INDEX_STALE")
        self.assertTrue(engine.index_stale)

    def test_equivalent_notations_and_unconfirmed_conditions(self):
        self.assertEqual(fact_signature("- 内存7/11 GB。", "memory"),
                         fact_signature("- 内存7 GB、11 GB。", "memory"))
        engine = self.engine(["## 待核验项\n\n- 目标充电器兼容性（虚构测试）。\n"])
        result = make_answer(engine, "ProS充电器有什么要核验的", 5)
        self.assertEqual(result["status"], "answered")
        self.assertTrue(result["answer"].startswith("待核验："))


class PipelineTests(OfflineCase):
    """Exercise real index serialization, BM25 and matrix ranking with fake embeddings."""

    def setUp(self):
        super().setUp()
        try:
            rag_engine.numeric_dependencies()
        except RuntimeError as exc:
            self.skipTest(str(exc))
        self.np = rag_engine.np
        np = self.np

        class FixtureModel:
            max_seq_length = 512

            def get_sentence_embedding_dimension(self):
                return 3

            def encode(self, texts, **kwargs):
                vectors = np.asarray([[1 + t.count("苹果"), 1 + t.count("香蕉"), 1]
                                      for t in texts], dtype=np.float32)
                return vectors / np.linalg.norm(vectors, axis=1)[:, None]

        self.model_patch = patch.object(rag_engine, "make_model", return_value=FixtureModel())
        self.loader = self.model_patch.start()
        self.write("苹果说明.markdown", "# 虚构测试\n苹果资料，仅用于离线测试。\r\n")
        self.write("香蕉说明.md", "# 虚构测试\n香蕉资料，仅用于离线测试。\n")
        self.write("picture.bin", b"\x00\xff")
        self.output = io.StringIO()

    def build(self):
        with redirect_stdout(self.output):
            return rag_engine.build(self.config)

    def engine(self):
        return Engine(self.config)

    def test_build_load_all_strategies_and_reuse_without_loading_model(self):
        manifest = self.build()
        self.assertEqual(manifest["files"], 3)
        self.assertEqual(manifest["fingerprint"], fingerprint(scan_documents(self.library)))
        self.assertNotIn(str(self.library), json.dumps(manifest))
        self.assertFalse((RAG_DIR / "rag-index").exists())
        self.loader.reset_mock()
        self.assertEqual(self.build()["signature"], manifest["signature"])
        self.loader.assert_not_called()
        engine = self.engine()
        for strategy in ("exact", "lexical", "vector", "hybrid"):
            result = engine.search("苹果", 2, strategy)
            self.assertEqual(result["strategy"], strategy)
            self.assertEqual(result["indexFingerprint"], manifest["fingerprint"])
            self.assertEqual(result["verifiedSnapshot"], {
                "service": "ima-local-rag", "apiVersion": 2, "files": 3,
                "fingerprint": manifest["fingerprint"], "ready": True,
                "indexStale": False, "verification": "full-content-per-request",
            })
            self.assertFalse(result["onlineUsed"])
            self.assertLessEqual(result["returned"], 2)
            self.assertEqual(result["results"][0]["path"], "苹果说明.markdown")
        exact = engine.search("苹果", strategy="exact")["results"][0]
        text = (self.library / exact["path"]).read_text(encoding="utf-8")
        self.assertEqual(exact["preview"], text[exact["start"]:exact["end"]])
        health = engine.health()
        self.assertEqual(health["service"], "ima-local-rag")
        self.assertEqual(health["fingerprint"], manifest["fingerprint"])
        self.assertTrue(health["ready"])
        self.assertFalse(health["indexStale"])

    def test_query_and_answer_each_verify_full_snapshot_once_and_detect_changes(self):
        self.write("P1-产品参数库/06-型号检索卡/HUAWEI MateBook Pro S/核心硬件卡.md",
                   "# 虚构离线资料\n\n## 已确认事实\n\n- 内存7 GB，仅用于虚构测试。\n")
        manifest = self.build()
        engine = self.engine()
        self.addCleanup(engine.vectors._mmap.close)
        with patch.object(engine, "verify_snapshot", wraps=engine.verify_snapshot) as verify:
            empty = engine.search("不存在的字面词", 50, "exact")
            self.assertEqual(empty["results"], [])
            self.assertEqual(empty["verifiedSnapshot"]["files"], 4)
            self.assertEqual(verify.call_count, 1)
            for q, status in [("ProS内存多大", "answered"), ("MateBook14内存", "clarify"),
                              ("今天多少钱", "insufficient_evidence")]:
                with self.subTest(query=q):
                    verify.reset_mock()
                    out = engine.answer(q)
                    self.assertEqual(out["status"], status)
                    self.assertEqual(out["verifiedSnapshot"]["fingerprint"], manifest["fingerprint"])
                    self.assertEqual(verify.call_count, 1)
        # Even a binary source not returned by the query participates in validation.
        self.write("picture.bin", b"\x01\xff")
        with self.assertRaises(CorpusChanged):
            engine.search("不存在的字面词", 50, "exact")
        with self.assertRaises(CorpusChanged):
            engine.answer("ProS内存多大")

    def test_tampered_metadata_and_vectors_cannot_load(self):
        self.build()
        for filename in ("documents.json", "chunks.json", "vectors.npy"):
            file = self.config.store / filename
            original = file.read_bytes()
            file.write_bytes(original + b" ")
            with self.subTest(filename=filename), self.assertRaisesRegex(RuntimeError, "校验"):
                self.engine()
            file.write_bytes(original)

    def test_model_change_requires_rebuild_and_health_detects_corpus_change(self):
        first = self.build()
        (self.model / "config.json").write_text('{"fixture": "changed"}', encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "模型"):
            self.engine()
        self.assertNotEqual(self.build()["signature"], first["signature"])
        engine = self.engine()
        self.write("new.md", "新增虚构资料")
        health = engine.health()
        self.assertFalse(health["ready"])
        self.assertTrue(health["indexStale"])
        with self.assertRaises(CorpusChanged):
            engine.search("苹果")

    def test_corrupt_completed_index_is_rebuilt(self):
        self.build()
        for filename in ("chunks.json", "manifest.json"):
            (self.config.store / filename).write_text("broken", encoding="utf-8")
            self.loader.reset_mock()
            self.build()
            self.loader.assert_called_once()
            self.assertTrue(self.engine().health()["ready"])

    def test_interrupted_build_resumes_and_bad_checkpoint_restarts(self):
        np = self.np
        for done in (-1, 99999, "3", 1):
            self.build()
            manifest = json.loads((self.config.store / "manifest.json").read_text(encoding="utf-8"))
            (self.config.store / "manifest.json").unlink()
            partial = self.config.store / "vectors.partial.npy"
            vectors = np.lib.format.open_memmap(partial, mode="w+", dtype="float32",
                                               shape=(manifest["chunks"], 3))
            vectors[:] = np.asarray([1, 1, 1], dtype=np.float32) / np.sqrt(3)
            vectors.flush()
            del vectors
            (self.config.store / "build-progress.json").write_text(
                json.dumps({"signature": manifest["signature"], "done": done}), encoding="utf-8")
            self.build()
            self.assertTrue(self.engine().health()["ready"])
            self.assertFalse((self.config.store / "build-progress.json").exists())


@unittest.skipUnless(shutil.which("node"), "Node.js unavailable; adapter contract check skipped")
class AdapterContractTests(AnswerFixtureCase):
    def node(self, code, payload):
        process = subprocess.run(
            ["node", "--input-type=module", "-e", code], input=json.dumps(payload, ensure_ascii=False),
            text=True, encoding="utf-8", capture_output=True, timeout=20, check=True)
        return json.loads(process.stdout)

    def test_fingerprint_matches_adapter_utf16_sort_and_spacing(self):
        for name in ("Z.md", "a.md", "中文.markdown", "😀.bin", "\ue000.txt"):
            self.write(name, "fictional:" + name)
        docs = scan_documents(self.library)
        actual = self.node("""
            import { createHash } from 'node:crypto';
            let input = ''; for await (const part of process.stdin) input += part;
            const docs = JSON.parse(input);
            docs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
            const text = `[${docs.map(d => `[${JSON.stringify(d.path)}, ${JSON.stringify(d.sha256)}]`).join(', ')}]`;
            console.log(JSON.stringify(createHash('sha256').update(text).digest('hex')));
        """, docs)
        self.assertEqual(actual, fingerprint(docs))

    def test_actual_adapter_verifiers_accept_answer_and_crlf_offsets(self):
        text = "## 已确认事实\r\n\r\n内存7 GB，仅限虚构😀测试款。\r\n第二行延续限定说明。\r\n"
        engine = self.engine([text.replace("\r\n", "\n")])
        self.write(engine.docs[0]["path"], text)
        engine.docs[0]["sha256"] = hashlib.sha256(text.encode()).hexdigest()
        result = make_answer(engine, "ProS内存多大", 5)
        self.assertEqual(result["status"], "answered")
        checked = self.node("""
            import { readFileSync } from 'node:fs';
            let input = ''; for await (const part of process.stdin) input += part;
            const { adapter, body, text } = JSON.parse(input);
            const source = readFileSync(adapter, 'utf8');
            const functions = source.slice(source.indexOf('function verifyPassage('),
                                           source.indexOf('function parameter('));
            const verify = new Function('stale', functions + '; return { verifyPassage, verifyExtractiveAnswer };')
                (() => new Error('stale fixture'));
            verify.verifyExtractiveAnswer(body);
            for (const citation of body.citations) verify.verifyPassage(citation, Buffer.from(text), true);
            console.log(JSON.stringify(body));
        """, {"adapter": str(EXPECTED_ADAPTER),
               "body": result, "text": text})
        for citation in checked["citations"]:
            self.assertEqual(citation["offsetEncoding"], "unicode-code-points")
            self.assertEqual(text[citation["start"]:citation["end"]], citation["preview"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
