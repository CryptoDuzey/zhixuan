"""Pure request validation: safe to test without creating listeners."""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit


def loopback_address(address):
    if not isinstance(address, tuple) or len(address) != 2 or address[0] != "127.0.0.1":
        raise ValueError("HTTP 仅允许绑定 127.0.0.1")
    port = address[1]
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("端口须为1至65535的整数")
    return address


def validate_query(q, top_k, strategy):
    if not isinstance(q, str) or not q.strip() or len(q) > 1000:
        raise ValueError("问题不能为空，且不能超过1000字")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", q):
        raise ValueError("问题包含无效控制字符")
    if type(top_k) is not int or not 1 <= top_k <= 50:
        raise ValueError("top_k 须在1至50之间")
    if strategy not in {"exact", "lexical", "vector", "hybrid"}:
        raise ValueError("strategy 须为 exact、lexical、vector、hybrid")


def parse_request(target):
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        raise ValueError("请求地址须为本机相对路径")
    if parsed.path not in {"/search", "/answer"}:
        raise ValueError("未知接口")
    if re.search(r"%(?![0-9a-fA-F]{2})", parsed.query):
        raise ValueError("参数编码无效")
    args = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=10,
                    encoding="utf-8", errors="strict")
    if any(len(v) != 1 for v in args.values()):
        raise ValueError("参数不可重复")
    if set(args) - {"q", "top_k", "strategy"}:
        raise ValueError("存在不支持的参数")
    if parsed.path == "/answer" and "strategy" in args:
        raise ValueError("回答接口固定使用混合检索，不接受strategy")
    q = args.get("q", [""])[0]
    raw_k = args.get("top_k", ["5" if parsed.path == "/answer" else "10"])[0]
    if not re.fullmatch(r"[0-9]{1,2}", raw_k):
        raise ValueError("top_k 须为1至50的整数")
    strategy = args.get("strategy", ["hybrid"])[0]
    validate_query(q, int(raw_k), strategy)
    return parsed.path, q, int(raw_k), strategy
