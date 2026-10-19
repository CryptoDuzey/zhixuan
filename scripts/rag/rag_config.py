"""Configuration without model imports, filesystem writes, or network access."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from typing import Mapping

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STORE = PROJECT_ROOT / "app" / "data" / "private" / "rag"
SOURCE_ROOT = PROJECT_ROOT / "scripts"


def _path(value: str) -> Path:
    return Path(value).expanduser().resolve()


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def integer_setting(env: Mapping[str, str], name: str, default: int,
                    low: int, high: int) -> int:
    raw = env.get(name, str(default))
    if not raw.isascii() or not raw.isdecimal() or not low <= int(raw) <= high:
        raise ValueError(f"{name} 须为 {low} 至 {high} 的整数")
    return int(raw)


@dataclass(frozen=True)
class Config:
    library: Path
    store: Path
    model: Path

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        for name in ("ZHIXUAN_KB_DIR", "ZHIXUAN_EMBEDDING_MODEL"):
            if not env.get(name, "").strip():
                raise ValueError(f"请设置 {name}，指向已准备好的本地目录")
        if "ZHIXUAN_RAG_STORE" in env and not env["ZHIXUAN_RAG_STORE"].strip():
            raise ValueError("ZHIXUAN_RAG_STORE 不能为空")
        config = cls(
            _path(env["ZHIXUAN_KB_DIR"]),
            _path(env.get("ZHIXUAN_RAG_STORE", str(DEFAULT_STORE))),
            _path(env["ZHIXUAN_EMBEDDING_MODEL"]),
        )
        config.validate()
        return config

    def validate(self) -> None:
        if not self.library.is_dir():
            raise ValueError("ZHIXUAN_KB_DIR 必须指向已存在的目录")
        if not self.model.is_dir():
            raise ValueError("ZHIXUAN_EMBEDDING_MODEL 必须指向已准备好的本地模型目录")
        if self.store.exists() and not self.store.is_dir():
            raise ValueError("ZHIXUAN_RAG_STORE 必须是目录")
        if _within(self.store, SOURCE_ROOT):
            raise ValueError("索引与日志不能放在 scripts 源码目录中")
        for other in (self.library, self.model):
            if _within(self.store, other) or _within(other, self.store):
                raise ValueError("索引目录必须与知识库、模型目录分开，且不能互相包含")


@dataclass(frozen=True)
class ServerConfig:
    port: int = 8766
    health_port: int = 8767
    max_workers: int = 8

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ServerConfig":
        env = os.environ if env is None else env
        config = cls(
            integer_setting(env, "IMA_RAG_PORT", 8766, 1, 65535),
            integer_setting(env, "IMA_RAG_HEALTH_PORT", 8767, 1, 65535),
            integer_setting(env, "IMA_RAG_MAX_WORKERS", 8, 1, 32),
        )
        if config.port == config.health_port:
            raise ValueError("查询端口与健康检查端口必须不同")
        return config
