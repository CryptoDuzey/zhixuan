"""Loopback-only API with bounded workers, observable outcomes and safe overload."""
import json
import logging
from logging.handlers import RotatingFileHandler
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
import os
import re
import threading
import time
from urllib.parse import urlsplit
import uuid

if __package__:
    from .rag_config import Config, ServerConfig
    from .rag_corpus import CorpusChanged
    from .rag_engine import Engine
    from .rag_protocol import loopback_address, parse_request
else:
    from rag_config import Config, ServerConfig
    from rag_corpus import CorpusChanged
    from rag_engine import Engine
    from rag_protocol import loopback_address, parse_request


# Match the adapter: 1000 Unicode code points need up to 12000 percent-encoded
# bytes. Keep the separate 1000-character validation in parse_request unchanged.
MAX_URL_BYTES = 16 * 1024
MAX_OVERLOAD_DRAIN_BYTES = MAX_URL_BYTES + 8 * 1024


class Runtime:
    def __init__(self, engine, logger=None):
        self.engine = engine
        self.logger = logger or logging.getLogger("rag-access")
        self.stats_lock = threading.Lock()
        self.stats = {"accepted": 0, "completed": 0, "active": 0, "overloaded": 0,
                      "errors": 0, "http4xx": 0, "maxActive": 0, "totalLatencyMs": 0}


def error_body(code, message, request_id, retryable=False):
    return {"schemaVersion": 2, "status": "unavailable", "reasonCode": code,
            "error": message, "requestId": request_id, "retryable": retryable,
            "answer": "", "citations": [], "claims": [],
            "abstained": True, "evidenceSufficient": False}


class Handler(BaseHTTPRequestHandler):
    server_version = "KnowledgeAPI/2"

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def send(self, code, value, headers=None):
        request_id = getattr(self, "request_id", uuid.uuid4().hex)
        value = {**value, "requestId": request_id}
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Request-ID", request_id)
        self.send_header("Connection", "close")
        for name, content in (headers or {}).items():
            self.send_header(name, content)
        self.end_headers()
        self.wfile.write(data)
        self.response_status = code
        self.response_reason = value.get("reasonCode")
        self.close_connection = True

    def request_identity(self):
        incoming = self.headers.get("X-Request-ID", "")
        self.request_id = incoming if re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", incoming) else uuid.uuid4().hex

    def do_POST(self):
        self.request_identity()
        self.send(405, error_body("METHOD_NOT_ALLOWED", "仅支持读取", self.request_id))

    do_PUT = do_DELETE = do_PATCH = do_POST

    def do_GET(self):
        self.request_identity()
        runtime = self.server.runtime
        engine, stats, stats_lock, logger = (
            runtime.engine, runtime.stats, runtime.stats_lock, runtime.logger)
        start = time.monotonic()
        route = "unknown"
        try:
            if len(self.path.encode("utf-8")) > MAX_URL_BYTES:
                return self.send(414, error_body("REQUEST_TOO_LARGE", "请求地址过长", self.request_id))
            u = urlsplit(self.path)
            route = u.path if u.path in {"/health", "/search", "/answer"} else "unknown"
            if u.path == "/health":
                with stats_lock:
                    metrics = dict(stats)
                return self.send(200, {**engine.health(), "runtime": metrics,
                                       "limits": {"maxWorkers": self.server.max_workers, "socketTimeoutSeconds": 5,
                                                  "maxUrlBytes": MAX_URL_BYTES}})
            if u.path not in {"/search", "/answer"}:
                return self.send(404, error_body("NOT_FOUND", "未知接口", self.request_id))
            _, q, top_k, strategy = parse_request(self.path)
            value = engine.answer(q, top_k) if u.path == "/answer" else engine.search(q, top_k, strategy)
            self.send(200, value)
        except CorpusChanged:
            self.send(409, error_body("INDEX_STALE", "资料已变化，请更新索引后再查询", self.request_id))
        except ValueError as e:
            self.send(400, error_body("INVALID_ARGUMENT", str(e), self.request_id))
        except (BrokenPipeError, ConnectionError, TimeoutError):
            self.response_status = 499
        except Exception as e:
            logger.error(json.dumps({"event": "handler_error", "type": type(e).__name__, "requestId": self.request_id}))
            self.send(500, error_body("INTERNAL_ERROR", "检索失败，请根据请求编号检查服务记录", self.request_id, True))
        finally:
            status = getattr(self, "response_status", 500)
            elapsed = round((time.monotonic()-start)*1000, 2)
            with stats_lock:
                stats["completed"] += 1
                stats["errors"] += int(status >= 500)
                stats["http4xx"] += int(400 <= status < 500)
                stats["totalLatencyMs"] += elapsed
            logger.info(json.dumps({"at": time.time(), "requestId": self.request_id,
                                    "route": route, "status": status, "latencyMs": elapsed,
                                    "reasonCode": getattr(self, "response_reason", None)}))


class Server(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, runtime, max_workers=8):
        loopback_address(address)
        self.runtime = runtime
        self.max_workers = max_workers
        if type(self.max_workers) is not int or not 1 <= self.max_workers <= 32:
            raise ValueError("IMA_RAG_MAX_WORKERS must be between 1 and 32")
        self.slots = threading.BoundedSemaphore(self.max_workers)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        stats, stats_lock = self.runtime.stats, self.runtime.stats_lock
        if not self.slots.acquire(blocking=False):
            request_id = uuid.uuid4().hex
            with stats_lock:
                stats["overloaded"] += 1
            body = json.dumps(error_body("BUSY", "服务繁忙，请稍后重试", request_id, True), ensure_ascii=False).encode("utf-8")
            try:
                # Read the pending request headers before closing. On Windows,
                # closing a socket with unread request bytes can reset the
                # connection and hide the structured 503 from the client.
                deadline = time.monotonic() + .05
                pending = b""
                while b"\r\n\r\n" not in pending and len(pending) < MAX_OVERLOAD_DRAIN_BYTES:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    request.settimeout(remaining)
                    try:
                        part = request.recv(min(4096, MAX_OVERLOAD_DRAIN_BYTES-len(pending)))
                    except TimeoutError:
                        break
                    if not part:
                        break
                    pending += part
                request.settimeout(1)
                request.sendall(
                    f"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {len(body)}\r\nRetry-After: 1\r\nX-Request-ID: {request_id}\r\nConnection: close\r\n\r\n".encode()+body)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        with stats_lock:
            stats["accepted"] += 1
            stats["active"] += 1
            stats["maxActive"] = max(stats["maxActive"], stats["active"])
        try:
            super().process_request(request, client_address)
        except Exception:
            self.release_slot()
            raise

    def release_slot(self):
        stats, stats_lock = self.runtime.stats, self.runtime.stats_lock
        with stats_lock:
            stats["active"] -= 1
        self.slots.release()

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.release_slot()


class HealthHandler(Handler):
    """Process probe with its own bounded listener, independent of query slots."""

    def setup(self):
        super().setup()
        self.connection.settimeout(.25)

    def do_GET(self):
        self.request_identity()
        runtime = self.server.runtime
        engine, stats, stats_lock = runtime.engine, runtime.stats, runtime.stats_lock
        try:
            if self.path != "/health":
                return self.send(404, error_body("NOT_FOUND", "此端口仅提供健康检查", self.request_id))
            with stats_lock:
                metrics = dict(stats)
            workers = self.server.query_server.max_workers
            self.send(200, {**engine.health(), "processId": os.getpid(),
                            "healthEndpointRole": "management", "probeScope": "process_only",
                            "querySaturated": metrics["active"] >= workers, "runtime": metrics,
                            "limits": {"maxWorkers": workers, "healthWorkers": 1,
                                       "healthSocketTimeoutSeconds": .25}})
        except (ConnectionError, TimeoutError):
            pass


class HealthServer(HTTPServer):
    # Serial probes cannot create unbounded threads. Slow/incomplete probes time
    # out independently of the main query listener.
    request_queue_size = 8
    allow_reuse_address = True

    def __init__(self, address, handler, query_server):
        loopback_address(address)
        self.query_server = query_server
        self.runtime = query_server.runtime
        super().__init__(address, handler)


def main():
    # Explicit entry point only: importing this module never opens files/sockets
    # or loads a model.
    import argparse
    parser = argparse.ArgumentParser(description="仅限本机访问的可选混合检索服务")
    parser.parse_args()
    config = Config.from_env()
    settings = ServerConfig.from_env()
    engine = Engine(config)
    config.store.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("rag-access")
    logger.setLevel(logging.INFO)
    log_handler = RotatingFileHandler(config.store/"rag-access.jsonl", maxBytes=5_000_000,
                                      backupCount=2, encoding="utf-8")
    logger.addHandler(log_handler)
    runtime = Runtime(engine, logger)
    server = Server(("127.0.0.1", settings.port), Handler, runtime, settings.max_workers)
    try:
        health_server = HealthServer(("127.0.0.1", settings.health_port), HealthHandler, server)
    except Exception:
        server.server_close()
        raise
    threading.Thread(target=health_server.serve_forever, daemon=True, name="rag-health").start()
    print(f"RAG v2 ready on 127.0.0.1:{settings.port}; health=127.0.0.1:{settings.health_port}; {len(engine.chunks)} chunks; workers={server.max_workers}.", flush=True)
    try:
        server.serve_forever()
    finally:
        health_server.shutdown()
        health_server.server_close()
        server.server_close()
        logger.removeHandler(log_handler)
        log_handler.close()


if __name__ == "__main__":
    main()
