"""Conservative short answers made only of intact, attributed source passages."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re


# Each facet is both a user request recognizer and a source sentence requirement.
# A document-level similarity score alone never authorizes an answer sentence.
FACETS = {
    "memory": (r"内存|运存|ram", r"内存|运存|ram"),
    "storage": (r"硬盘|存储|固态|ssd", r"硬盘|存储|固态|ssd"),
    "cpu": (r"处理器|芯片|cpu", r"处理器|芯片|cpu|麒麟"),
    "gpu": (r"显卡|gpu", r"显卡|gpu|图形"),
    "resolution": (r"分辨率|像素|清晰|清楚", r"分辨率|ppi|\d+\s*[×x]\s*\d+"),
    "refresh": (r"刷新|多少hz|几hz", r"刷新|hz"),
    "brightness": (r"亮度|nit", r"亮度|nit"),
    "screen_size": (r"屏幕尺寸|屏幕多大|几寸|多少寸", r"屏幕尺寸|英寸"),
    "weight": (r"多重|重量|几斤|多沉|轻不轻|重不重|通勤|便携|携带|出差", r"重量|重约|约[\d.]+\s*(?:kg|g)|\d[\d.]*\s*kg"),
    "thickness": (r"厚度|多厚|薄不薄", r"厚|薄"),
    "battery": (r"电池容量|电池|多少wh", r"电池|wh"),
    "runtime": (r"续航|能用多久|用几小时", r"续航|小时"),
    "ports": (r"接口|插口|usb|hdmi|type.?c|扩展坞", r"接口|usb|hdmi|音频|扩展坞"),
    "charging": (r"充电|充电器|适配器|供电", r"充电|适配器"),
    "system": (r"系统|操作系统|鸿蒙版本|windows版本|迁移|迁过来|互联|协同|互传|生态", r"系统|harmonyos|windows|linux|迁移|互联|协同|互传"),
    "compatibility": (r"软件|兼容|能装|安装.*(?:应用|程序)|windows程序|原来的应用", r"软件|兼容|应用|适配"),
    "screen": (r"屏幕|显示|护眼|oled|柔光", r"屏幕|显示|护眼|oled|柔光"),
    "performance": (r"性能|功耗|性能释放|多开|多任务|并发程序", r"性能|功耗"),
    "fit": (r"适合|不适合|适用人群|适用场景|使用边界|缺点|限制|避坑", r"适合|适用|限制|不适用|不能|未确认"),
    "camera": (r"摄像头规格|摄像头像素", r"摄像头|像素"),
    "keyboard": (r"键盘|指纹|触控板", r"键盘|指纹|触控板"),
    "wireless": (r"无线规格|wifi规格|蓝牙版本", r"wi-fi|wifi|蓝牙|无线"),
    "color": (r"颜色|配色", r"颜色|配色|灰|白|黑|蓝|紫|黄"),
}

SERVICE_INTENTS = {
    "warranty_lookup": (r"保修.*(?:查|看|到期)|(?:查|看|有没有|还有没有).*(?:保修|权益)", r"查询保修期|保修期.*查询", ["保修期", "权益查询", "S/N"]),
    "warranty_proof": (r"保修凭证|保修.*(?:证明|凭证|发票)", r"保修凭证", ["凭证", "发票"]),
    "repair_status": (r"维修进度|修到哪|维修.*(?:进展|状态)", r"维修进度", ["维修进度", "服务单"]),
    "mail_repair": (r"寄修|邮寄维修|邮寄.*修", r"寄修", ["寄修", "邮寄"]),
    "repair_booking": (r"预约.*维修|预约修|维修.*预约", r"预约维修", ["预约", "服务"]),
    "spare_price": (r"备件|配件.*(?:价格|报价)|维修.*(?:价格|报价)|换电池.*(?:多少|价格)", r"备件价格", ["备件价格", "部件", "参考价"]),
    "return_policy": (r"退换|退货|换货", r"退换货", ["退换", "凭证"]),
    "onsite": (r"上门", r"上门服务", ["上门", "地区"]),
    "model_lookup": (r"(?:怎么|如何|哪里).*(?:确认|查看|查).*(?:型号|序列号)|怎么看型号", r"确认完整型号|查看型号|序列号", ["型号", "序列号"]),
    "software_install": (r"专业软件.*(?:安装|能装)|软件能否安装", r"专业软件能否安装", ["软件", "版本", "兼容"]),
    "host_warranty": (r"(?:主机|电脑|笔记本).*(?:保修多久|保修几年|保修期限)", r"主机保修多久", ["保修", "年"]),
    "battery_warranty": (r"电池.*(?:保修多久|保修几年|保修期限)", r"电池保修多久", ["电池", "保修"]),
    "no_warranty": (r"什么情况.*不保|哪些.*不保|保修.*除外", r"什么情况不保修", ["保修", "损坏"]),
    "driver": (r"驱动.*(?:下载|更新|安装)|(?:下载|更新|安装).*驱动", r"如何下载驱动", ["驱动", "型号"]),
    "manual": (r"手册|说明书", r"查找产品手册", ["手册", "型号"]),
    "manager": (r"电脑管家.*(?:用|下载|安装)|(?:使用|下载|安装).*电脑管家", r"如何使用电脑管家", ["电脑管家", "系统"]),
    "backup": (r"备份|换机.*数据", r"换机前如何备份", ["备份", "数据"]),
    "pc_clone": (r"pc克隆|电脑克隆", r"如何使用PC克隆", ["克隆", "迁移"]),
    "wifi": (r"wifi|wi-fi|无线网.*(?:断|不稳|慢|连不上)", r"Wi-Fi连接不稳定", ["网络", "驱动", "Wi-Fi"]),
    "campus": (r"校园网", r"校园网连接问题", ["校园网", "认证", "网络"]),
    "enterprise_network": (r"公司.*网络|企业网络", r"企业网络无法访问", ["网络", "认证", "企业"]),
    "single_app_network": (r"单个应用.*联网|只有.*(?:软件|应用).*上不了网", r"单个应用无法联网", ["应用", "网络"]),
    "bluetooth_mouse": (r"蓝牙鼠标", r"怎样连接蓝牙鼠标", ["蓝牙", "鼠标"]),
    "bluetooth_headset": (r"蓝牙耳机", r"怎样连接蓝牙耳机", ["蓝牙", "耳机"]),
    "camera_issue": (r"摄像头.*(?:不能|无法|不工作|没画面)", r"摄像头无法使用", ["摄像头", "权限"]),
    "mic_issue": (r"麦克风.*(?:没有|没声音|不能|无法|录不到)|录音.*没声音", r"麦克风没有声音", ["麦克风", "权限", "输入"]),
    "speaker_issue": (r"扬声器.*(?:没声音|没有|无法)|电脑没声音", r"扬声器没有声音", ["声音", "输出", "扬声器"]),
    "update_fail": (r"更新.*(?:失败|报错)", r"系统更新失败", ["更新", "系统"]),
    "update_prepare": (r"更新前.*(?:准备|注意)", r"系统更新前准备", ["备份", "更新"]),
    "dock_issue": (r"扩展坞.*(?:不识别|无法|不能)", r"接口扩展坞不识别", ["扩展坞", "接口"]),
    "usb_charge_issue": (r"usb.?c.*(?:不能|无法|不支持).*充电", r"USB-C不能充电", ["充电", "USB"]),
    "display_issue": (r"外接显示器.*(?:无信号|不亮|黑屏)", r"外接显示器无信号", ["显示器", "接口", "信号"]),
    "cast_issue": (r"投屏.*(?:失败|不能|无法)", r"投屏失败如何排查", ["投屏", "设备"]),
    "brightness_issue": (r"亮度.*(?:无法|不能|不能调)", r"屏幕亮度无法调节", ["亮度", "驱动"]),
    "battery_care": (r"保养电池|电池.*保养|电池保护", r"如何科学保养电池", ["电池", "温度"]),
    "runtime_gap": (r"续航.*(?:宣传|不一样|不同|差)", r"续航为何与宣传不同", ["续航", "亮度", "应用"]),
    "phone_collab": (r"手机.*协同.*(?:条件|要求)|协同手机", r"手机协同需要什么条件", ["手机", "协同"]),
    "tablet_collab": (r"平板.*协同.*(?:条件|要求)", r"平板协同需要什么条件", ["平板", "协同"]),
}


def normalized(s):
    import unicodedata
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s).lower())


def service_intent(q):
    # Specific service actions take priority over generic warranty words.
    priority = ["warranty_proof", "repair_status", "mail_repair", "repair_booking",
                "spare_price", "return_policy", "onsite", "model_lookup", "software_install", "warranty_lookup"]
    priority = [k for k in SERVICE_INTENTS if k not in priority] + priority
    return next((k for k in priority if re.search(SERVICE_INTENTS[k][0], normalized(q))), None)


def requested_facets(q):
    n = normalized(q)
    facets = [k for k, (pattern, _) in FACETS.items() if re.search(pattern, n)]
    if "screen" in facets and any(f in facets for f in ["resolution", "refresh", "brightness", "screen_size"]):
        facets.remove("screen")
    if not facets and re.search(r"配置|规格参数", n):
        facets = ["cpu", "memory", "storage"]
    return facets


@dataclass(frozen=True)
class Passage:
    start: int
    end: int
    section: str
    text: str


def passages(text):
    """Whole list items or paragraphs; offsets always address the original text."""
    section = ""
    block_start = None
    block_end = None
    out = []

    def flush():
        nonlocal block_start, block_end
        if block_start is not None:
            start, end = block_start, block_end
            while start < end and text[start].isspace():
                start += 1
            while end > start and text[end-1].isspace():
                end -= 1
            if end > start:
                out.append(Passage(start, end, section, text[start:end]))
        block_start = block_end = None

    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        heading = re.match(r"^#{1,6}\s+(.+)", stripped)
        if heading:
            flush()
            section = heading.group(1)
        elif not stripped or stripped.startswith((">", "<!--", "|")):
            flush()
        elif re.match(r"^(?:[-*]|\d+[.、])\s+", stripped):
            flush()
            start = offset + len(line) - len(line.lstrip())
            end = offset + len(line.rstrip())
            out.append(Passage(start, end, section, text[start:end]))
        else:
            if block_start is None:
                block_start = offset
            block_end = offset + len(line.rstrip())
        offset += len(line)
    flush()
    return out


def clean_quote(text):
    return re.sub(r"^(?:[-*]|\d+[.、])\s+", "", text).strip()


def fact_signature(text, facet):
    """Compare values of the requested property, not every number in a passage."""
    t = clean_quote(text).lower()
    if facet in {"memory", "storage"}:
        labels = r"内存|运存" if facet == "memory" else r"存储|硬盘|固态"
        m = re.match(rf"(?:{labels})[^。；，,\n]*", t)
        if not m:
            return frozenset()
        values = set()
        for amounts, unit in re.findall(r"(\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?)*)\s*(gb|tb)", m.group(0)):
            values.update(amount+unit for amount in amounts.split("/"))
        return frozenset(values)
    if facet == "cpu":
        return frozenset(re.findall(r"(?:麒麟|酷睿|ryzen|intel)[a-z0-9-]+", normalized(t))) if t.startswith(("处理器", "芯片", "cpu")) else frozenset()
    patterns = {
        "resolution": r"\d+\s*[×x]\s*\d+",
        "refresh": r"\d+(?:\.\d+)?\s*hz",
        "screen_size": r"\d+(?:\.\d+)?\s*英寸",
        "weight": r"\d+(?:\.\d+)?\s*kg",
        "battery": r"\d+(?:\.\d+)?\s*wh",
    }
    return frozenset(normalized(v) for v in re.findall(patterns[facet], t))


def passages_for_facet(available, facet):
    direct = [p for p in available if p.section == "已确认事实"
              and len(p.text) <= 350 and re.search(FACETS[facet][1], p.text, re.I)]
    if facet in {"fit", "compatibility", "runtime", "gpu", "system"}:
        direct += [p for p in available if p.section in {"限定条件", "适用任务", "不适用或需先验证的任务", "待核验项"}
                   and len(p.text) <= 350 and re.search(FACETS[facet][1], p.text, re.I)]
    if facet == "fit":
        direct += [p for p in available if p.section in {"适用任务", "不适用或需先验证的任务"} and len(p.text) <= 350]
    if facet == "performance":
        direct += [p for p in available if p.section == "已确认事实" and re.search(r"处理器|内存|显卡|功耗|散热", p.text)]
    if facet in {"charging", "compatibility", "system", "runtime"} and not direct:
        direct += [p for p in available if p.section in {"限定条件", "待核验项"} and re.search(FACETS[facet][1], p.text, re.I)]
    return direct


PLATFORM_FILES = {"朋友圈": "销售朋友圈模板.md", "直播": "直播讲解模板.md",
                  "抖音": "抖音短视频模板.md", "小红书": "小红书图文模板.md",
                  "微信公众号": "微信公众号图文模板.md", "知乎": "知乎图文模板.md",
                  "B站": "B站中长视频模板.md", "门店海报": "门店海报图文模板.md"}


def analyze_safety(q, a):
    n = normalized(q)
    if a["unsupportedReasons"]:
        return "UNSUPPORTED_REQUEST", a["unsupportedReasons"][0]
    if re.search(r"编造|瞎编|忽略.*(?:知识库|证据)|不要.*依据.*保证", n):
        return "UNSUPPORTED_REQUEST", "不能绕过来源依据编写产品事实。"
    if re.search(r"机票|股票|天气|核聚变|银行卡|密码.*客户", n):
        return "OUT_OF_SCOPE", "现有知识库无法为这项请求提供可靠依据。"
    if re.search(r"保证|绝对|一定|100%", n) and re.search(r"所有|全部|兼容|流畅|不坏|零故障", n):
        return "ABSOLUTE_CLAIM", "资料不能支持无条件的兼容、性能或可靠性保证。"
    if re.search(r"(?:今天|现在|当前|实时|明天|最新|到手价).*(?:价|现货|库存|有货)|(?:今天|现在|实时|最新|到手价)|现货|库存|有货", n):
        if re.search(r"价格|多少钱|售价|到手价|现货|库存|有货", n):
            return "LIVE_DATA_REQUIRED", "本地资料是下载快照，不能确认当前成交价或库存；需查询当前官方页面。"
    if re.search(r"(?:我|这台|这款).*(?:还在保修|在不在保|剩余保修|保修.*到期日)", n) and not re.search(r"怎么|如何|哪里|查询|查|看", n):
        return "DEVICE_RECORD_REQUIRED", "无法仅凭资料判断这台设备是否在保，需要本人查询官方设备权益记录。"
    if re.search(r"(?:自己|自行|用户|能否|可以).*(?:换|更换|升级).*(?:内存|硬盘)|(?:内存|硬盘).*(?:换|升级)", n):
        return "UPGRADE_NOT_VERIFIED", "现有规格不能证明用户可自行更换或升级，需要核对具体型号的官方维护说明。"
    return None


def response_base(found, status, reason, message):
    return {
        **found, "schemaVersion": 2, "status": status, "reasonCode": reason,
        "answerType": "extractive", "answer": message, "abstained": status != "answered",
        "evidenceSufficient": status == "answered", "citations": [], "results": [],
        "returned": 0,
        "claims": [], "conditions": [], "dataAsOf": [], "clarification": None,
        "warnings": [], "generationModelUsed": False,
        "sourceKind": "downloaded_snapshot", "answerCorrectnessGuaranteed": False,
    }


def make_answer(engine, q, top_k):
    # Retrieve beyond the display limit, then independently authorize answer sources.
    if type(top_k) is not int or not 1 <= top_k <= 50:
        raise ValueError("top_k 须在1至50之间")
    found = engine.search(q, max(top_k, 20), "hybrid")
    a = found["analysis"]
    safety = analyze_safety(q, a)
    if safety:
        return response_base(found, "insufficient_evidence", *safety)
    if engine.index_stale:
        return response_base(found, "insufficient_evidence", "INDEX_STALE", "资料已变化，请更新索引后再查询。")
    if a["ambiguousModel"]:
        out = response_base(found, "clarify", "AMBIGUOUS_MODEL", "你指的是鸿蒙版 MateBook 14，还是酷睿 Ultra 版？请同时注明年份。")
        out["clarification"] = {"question": out["answer"], "options": ["鸿蒙版", "酷睿 Ultra 版"]}
        return out
    if re.search(r"(?:原来|旧|已有).*(?:应用|软件|程序)|(?:应用|软件|程序).*(?:迁移|迁过来)", normalized(q)):
        out = response_base(found, "clarify", "SOFTWARE_DETAILS_REQUIRED",
                            "请提供需要迁移的软件名称、版本和原系统；现有应用清单不能证明旧应用可迁移或兼容，互联也需核对设备与系统版本。")
        out["clarification"] = {"question": out["answer"], "options": []}
        return out
    intent = service_intent(q)
    facets = requested_facets(q)
    platform = next((p for p in a["platforms"] if p in PLATFORM_FILES), None)
    platform_request = bool(platform and re.search(r"怎么|如何|结构|顺序|组织|格式", q))
    entities = a["entities"]
    if len(entities) > 1:
        return response_base(found, "clarify", "MULTIPLE_MODELS", "请分别确认两款电脑的完整型号、年份和配置，再逐项对比，避免拼接不同版本参数。")
    if entities and re.search(r"鸿蒙|harmony", normalized(q)) and entities[0] in {"d16", "d16se", "d14", "ultra14", "xpro", "gt"}:
        return response_base(found, "clarify", "MODEL_SYSTEM_CONFLICT", "所给型号与系统版本不一致，请确认完整型号和系统后再查询。")
    if entities and re.search(r"windows版|windows系统", normalized(q)) and entities[0] in {"harmony14", "pro", "pros", "fold"}:
        return response_base(found, "clarify", "MODEL_SYSTEM_CONFLICT", "所给型号与系统版本不一致，请确认完整型号和系统后再查询。")
    if not entities and facets and not intent and not platform_request:
        return response_base(found, "clarify", "MODEL_REQUIRED", "请提供电脑的完整型号、系统和年份，以便查询对应参数。")
    if "price" in a["topics"] and not intent:
        return response_base(found, "clarify", "SKU_REQUIRED", "请明确完整型号、内存/存储和款式；本地价格只能提供资料日期的快照，不能确认当前成交价。")
    if not intent and not facets and not platform_request:
        return response_base(found, "insufficient_evidence", "NO_SUPPORTED_FACT", "没有找到可直接回答所问内容的可靠事实；请明确要查询的型号和具体项目。")

    candidates = []
    year = re.findall(r"(20\d{2})\s*(?:年|款)", q)
    for rank, r in enumerate(found["results"]):
        di = engine.doc_by_id[r["id"]]
        d = engine.docs[di]
        if not d["textIndexed"]:
            continue
        ids = set(d["entities"])
        # Cross-product comparison material must never supply single-model facts.
        if entities and (ids != set(entities)):
            if not (intent and not ids):
                continue
        if platform_request:
            if "P6-营销素材库/02-平台模板/" not in d["path"] or d["title"] != PLATFORM_FILES[platform]:
                continue
        elif intent:
            if not d["path"].startswith("P7-") or not re.search(SERVICE_INTENTS[intent][1], d["title"]):
                continue
        elif not d["path"].startswith("P1-") or "06-型号检索卡/" not in d["path"]:
            continue
        if not intent and facets == ["fit"] and "06-适用人群与限制卡" not in d["path"]:
            continue
        text = engine.doc_text[di]
        if year and any(y not in text[:500] for y in year):
            continue
        if r["denseScore"] < engine.config.get("answerThreshold", .48):
            continue
        candidates.append((rank, di, r))

    if not candidates:
        if year:
            return response_base(found, "clarify", "YEAR_NOT_VERIFIED", "未找到能确认所给年份的对应资料，请核对完整型号和年份。")
        return response_base(found, "insufficient_evidence", "NO_MATCHING_SOURCE", "没有找到同时匹配对象、问题和可靠来源的直接依据。")

    selected = []
    conditions = []
    covered = set()
    candidates.sort(key=lambda entry: (-sum(bool(passages_for_facet(engine.answer_passages[entry[1]], f)) for f in facets), entry[0]))
    for rank, di, r in candidates:
        available = engine.answer_passages[di]
        if platform_request:
            eligible = [p for p in available if re.search(r"写作流程|格式|节奏|结构|流程|顺序", p.section)
                        and len(p.text) <= 500]
            if eligible:
                selected.extend((di, p, "platform_guidance", r) for p in eligible[:2])
                covered.add("platform_guidance")
                break
        elif intent:
            eligible = [p for p in available if p.section == "简短结论" and len(p.text) <= 500
                        and any(w.lower() in p.text.lower() for w in SERVICE_INTENTS[intent][2])]
            if eligible:
                selected.append((di, eligible[0], intent, r))
                covered.add(intent)
                break
        else:
            for facet in facets:
                if facet in covered:
                    continue
                matches = passages_for_facet(available, facet)
                if not matches:
                    continue
                # Keep multiple battery/weight or port facts together, including version qualifiers.
                if facet == "fit" and facets == ["fit"]:
                    take = [p for section in ("适用任务", "不适用或需先验证的任务")
                            for p in available if p.section == section and len(p.text) <= 350]
                    if not take:
                        continue
                else:
                    take = matches[:3] if facet in {"ports", "battery", "weight", "screen", "compatibility", "runtime", "gpu", "performance"} else matches[:1]
                selected.extend((di, p, facet, r) for p in take)
                covered.add(facet)
            if selected:
                # Conditions come from the same card as a selected fact, never a random source.
                if any(sdi == di for sdi, _, _, _ in selected):
                    conditions.extend((di, p, r) for p in available if p.section == "限定条件" and len(p.text) <= 250)

    required = {"platform_guidance"} if platform_request else ({intent} if intent else set(facets))
    if required - covered:
        out = response_base(found, "insufficient_evidence", "INCOMPLETE_EVIDENCE", "资料未能完整支持问题中的所有项目，请缩小问题或补充对应依据。")
        out["missingFields"] = sorted(required - covered)
        return out
    if not selected:
        return response_base(found, "insufficient_evidence", "NO_DIRECT_PASSAGE", "没有找到可以直接引用的完整事实句。")
    source_values = normalized(" ".join(p.text for _, p, _, _ in selected))
    value_pattern = r"\d+(?:\.\d+)?(?:gb|tb|wh|hz|w)(?![a-z])"
    queried_values = set(re.findall(value_pattern, normalized(q)))
    available_values = set(re.findall(value_pattern, source_values))
    if queried_values - available_values:
        return response_base(found, "insufficient_evidence", "PREMISE_NOT_VERIFIED",
                             "没有直接依据确认问题中的具体数值或组合，不能从其他规格推断。")

    # Verify current source bytes before issuing any answer; a citation can never
    # quietly point at newly edited content under the old index fingerprint.
    for di in {s[0] for s in selected}:
        d = engine.docs[di]
        try:
            current = (engine.read_source(d) if hasattr(engine, "read_source")
                       else (engine.library / d["path"]).read_bytes())
        except (OSError, RuntimeError):
            current = b""
        if hashlib.sha256(current).hexdigest() != d["sha256"]:
            engine.index_stale = True
            return response_base(found, "insufficient_evidence", "INDEX_STALE", "来源文件已变化，请更新索引后再查询。")

    # Compare independently indexed factual cards, not marketing/competitor texts.
    # Contradictions are not resolved by whichever source happened to rank first.
    for facet in covered if not intent and not platform_request else []:
        if facet not in {"memory", "storage", "cpu", "resolution", "refresh", "screen_size", "weight", "battery"}:
            continue
        variants = []
        for _, di, r in candidates:
            direct = [p for p in engine.answer_passages[di] if p.section == "已确认事实"
                      and re.search(FACETS[facet][1], p.text, re.I)]
            if direct:
                value = frozenset().union(*(fact_signature(p.text, facet) for p in direct))
                if value:
                    variants.append(value)
        if any(not (x.issubset(y) or y.issubset(x)) for x in variants for y in variants):
            return response_base(found, "insufficient_evidence", "SOURCE_CONFLICT", "匹配来源对同一项目的记录不一致，需要核验版本或当前官方来源后再回答。")

    out = response_base(found, "answered", "DIRECT_EVIDENCE", "")
    seen = {}

    def cite(di, p, r):
        key = (di, p.start, p.end)
        if key not in seen:
            number = len(out["citations"]) + 1
            d = engine.docs[di]
            text = engine.doc_text[di]
            citation = {
                **d, "number": number, "citationId": number, "source": "本地已下载知识库",
                "preview": p.text, "start": p.start, "end": p.end,
                "line": text.count("\n", 0, p.start)+1, "lineEnd": text.count("\n", 0, p.end)+1,
                "section": p.section, "documentUrl": "/document?id="+d["id"],
            }
            out["citations"].append(citation)
            seen[key] = number
        return seen[key]

    unique = set()
    for di, p, facet, r in selected:
        key = (di, p.start, p.end)
        if key in unique:
            for claim in out["claims"]:
                if claim["citationIds"] == [seen[key]] and facet not in claim["fields"]:
                    claim["fields"].append(facet)
            continue
        unique.add(key)
        number = cite(di, p, r)
        kind = "to_verify" if p.section == "待核验项" else ("limitation" if p.section in {"限定条件", "不适用或需先验证的任务"} else "source_fact")
        out["claims"].append({"text": clean_quote(p.text), "fields": [facet], "kind": kind,
                              "entities": entities, "citationIds": [number]})
    for di, p, r in conditions:
        if any(c["text"] == clean_quote(p.text) for c in out["conditions"]):
            continue
        number = cite(di, p, r)
        out["conditions"].append({"text": clean_quote(p.text), "citationIds": [number]})
    dates = set()
    for di in {s[0] for s in selected}:
        dates.update(re.findall(r"(?:抓取基准日|更新日期|采集日期|核验日期)[：:\s]*([0-9]{4}-[0-9]{2}-[0-9]{2})",
                                engine.doc_text[di][:1500]))
    out["dataAsOf"] = sorted(dates)
    out["applicableTo"] = {"entities": entities, "yearsRequested": year}
    labels = {"to_verify": "待核验：", "limitation": "限制：", "source_fact": ""}
    out["answer"] = "\n".join(labels[c["kind"]]+c["text"] + "".join(f'[{n}]' for n in c["citationIds"]) for c in out["claims"])
    out["warnings"] = ["依据为本地资料快照，未核验之后的变化。"]
    out["results"] = out["citations"].copy()
    out["returned"] = len(out["citations"])
    return out
