"""Complete corpus binding, including binary files, matching the JS adapter."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat

TEXT_EXT = {".md", ".markdown", ".csv", ".json", ".txt"}


class CorpusChanged(RuntimeError):
    """A source changed or cannot be read safely."""


def is_link(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _identity(info):
    # On Windows some Python runtimes report creation time from path.stat()
    # and change time from fstat(). Compare ctime only within the same API.
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def read_checked(root: Path, relative: str) -> bytes:
    parts = PurePosixPath(relative).parts
    if (not parts or "\\" in relative or ":" in relative
            or PurePosixPath(relative).is_absolute()
            or any(p in {"", ".", ".."} for p in relative.split("/"))):
        raise CorpusChanged("来源路径无效，请重建索引")
    try:
        root_before = root.stat()
        if is_link(root) or not root.is_dir():
            raise CorpusChanged("知识库根目录发生变化")
        path = root
        for part in parts:
            path = path / part
            if is_link(path):
                raise CorpusChanged("来源路径包含链接，请重建索引")
        before = path.stat()
        if not stat.S_ISREG(before.st_mode):
            raise CorpusChanged("来源不再是普通文件")
        with path.open("rb") as handle:
            opened = os.fstat(handle.fileno())
            data = handle.read()
            after = os.fstat(handle.fileno())
        # Repeat component checks to catch replacement while reading.
        current = root
        for part in parts:
            current /= part
            if is_link(current):
                raise CorpusChanged("来源路径发生变化")
        root_after = root.stat()
        current_info = path.stat()
        if (is_link(root) or (root_before.st_dev, root_before.st_ino)
                != (root_after.st_dev, root_after.st_ino)
                or _identity(before) != _identity(opened)
                or _identity(opened) != _identity(after)
                or _identity(after) != _identity(current_info)
                or before.st_ctime_ns != current_info.st_ctime_ns
                or opened.st_ctime_ns != after.st_ctime_ns
                or len(data) != after.st_size):
            raise CorpusChanged("来源文件在读取时发生变化")
        return data
    except OSError as exc:
        raise CorpusChanged("来源文件无法安全读取，请核对目录并重建索引") from exc


def corpus_files(root: Path):
    def failed(error):
        raise CorpusChanged("知识库目录无法完整读取") from error

    if not root.is_dir() or is_link(root):
        raise CorpusChanged("知识库根目录不可用")
    for folder, dirs, files in os.walk(root, followlinks=False, onerror=failed):
        # Match the adapter: skip links and Windows junctions, never follow them.
        dirs[:] = sorted(d for d in dirs if not is_link(Path(folder) / d))
        for name in sorted(files):
            path = Path(folder) / name
            if is_link(path) or not path.is_file():
                continue
            yield path


def path_sort_key(path: str) -> bytes:
    # JavaScript's `<` orders UTF-16 code units, including supplementary symbols.
    return path.encode("utf-16-be", errors="surrogatepass")


def fingerprint(docs) -> str:
    pairs = [(d["path"], d["sha256"])
             for d in sorted(docs, key=lambda d: path_sort_key(d["path"]))]
    return hashlib.sha256(json.dumps(pairs, ensure_ascii=False).encode("utf-8")).hexdigest()


def scan_documents(root: Path):
    docs = []
    for path in corpus_files(root):
        relative = path.relative_to(root).as_posix()
        data = read_checked(root, relative)
        docs.append({
            "id": hashlib.sha256(relative.encode("utf-8")).hexdigest()[:24],
            "title": path.name, "path": relative, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    return sorted(docs, key=lambda d: path_sort_key(d["path"]))


def model_fingerprint(root: Path) -> str:
    # Model loaders may follow links. Reject them instead of omitting weights
    # from the fingerprint and silently binding a different model.
    for folder, dirs, files in os.walk(root, followlinks=False):
        if any(is_link(Path(folder) / name) for name in dirs + files):
            raise ValueError("模型目录不能包含链接，请先准备独立完整的本地模型副本")
    docs = scan_documents(root)
    if not docs:
        raise ValueError("本地模型目录为空")
    return fingerprint(docs)
