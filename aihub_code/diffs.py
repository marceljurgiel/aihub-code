"""Diff previews shown before the user approves edit_file / write_file.

`preview` only reads; it never writes anything.
"""
from __future__ import annotations

import difflib
import os
import stat
from dataclasses import asdict, dataclass

from .engine.file_ops import apply_edit, decode_text
from aihub.tools.workdir import resolve, workdir

LARGE_BYTES = 1_000_000
BINARY_SNIFF = 8000


@dataclass
class Diff:
    path: str
    text: str
    added: int
    removed: int
    created: bool
    truncated: bool = False
    error: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _rel(path: str) -> str:
    try:
        root = os.path.abspath(workdir())
        full = os.path.abspath(path)
        if os.path.commonpath([root, full]) == root and full != root:
            return os.path.relpath(full, root).replace(os.sep, "/")
    except ValueError:
        pass
    return path


def _lines(text: str) -> list[str]:
    out = text.splitlines(keepends=True)
    if out and not out[-1].endswith(("\n", "\r")):
        out[-1] += "\n\\ No newline at end of file\n"
    return out


def unified_diff(old: str, new: str, path: str, max_lines: int = 200) -> Diff:
    rel = _rel(path)
    lines = list(difflib.unified_diff(_lines(old), _lines(new), fromfile="a/" + rel,
                                      tofile="b/" + rel, n=3))
    body = lines[2:]  # skip the ---/+++ headers
    added = sum(1 for ln in body if ln.startswith("+"))
    removed = sum(1 for ln in body if ln.startswith("-"))
    # Normalise every output line to end with exactly one newline.
    lines = [ln if ln.endswith("\n") else ln + "\n" for ln in lines]
    total = len(lines)
    truncated = total > max_lines
    if truncated:
        lines = lines[:max_lines] + [f"... ({total - max_lines} more lines)"]
    text = "".join(lines)
    return Diff(path=rel, text=text.rstrip("\n") if truncated else text,
                added=added, removed=removed, created=False, truncated=truncated)


def _summary(path: str, n: int, created: bool = False) -> Diff:
    return Diff(path, f"binary or large file ({n} bytes)", 0, 0, created)


def _error(path: str, msg: str) -> Diff:
    return Diff(path=path, text="", added=0, removed=0, created=False, error=msg)


def preview(name: str, args: dict) -> Diff | None:
    if name not in ("edit_file", "write_file"):
        return None
    raw_path = ""
    try:
        raw_path = str(args.get("path", ""))
        if not isinstance(args.get("path"), str) or not args["path"]:
            return _error(raw_path, "missing or invalid `path`")
        path = resolve(raw_path)
        rel = _rel(path)
        if name == "edit_file":
            return _preview_edit(path, rel, args)
        return _preview_write(path, rel, args)
    except Exception as e:  # a preview must never break the turn
        return _error(raw_path, f"could not preview: {e}")


def _special(path: str) -> bool:
    """True for an existing path that is not a regular file (device, FIFO,
    socket): reading it could block or never end."""
    try:
        return not stat.S_ISREG(os.stat(path).st_mode)
    except OSError:
        return False


def _not_regular(rel: str, path: str) -> Diff:
    return _error(rel, f"[File Error] {path} is not a regular file (a device, pipe or socket).")


def _read(path: str) -> bytes:
    """At most LARGE_BYTES + 1 bytes; callers check the size first."""
    with open(path, "rb") as f:
        return f.read(LARGE_BYTES + 1)


def _preview_edit(path: str, rel: str, args: dict) -> Diff:
    old, new = args.get("old"), args.get("new")
    if not isinstance(old, str) or not isinstance(new, str):
        return _error(rel, "`old` and `new` must be strings")
    if not os.path.exists(path):
        return _error(rel, f"[Edit Error] File not found: {path}. edit_file only "
                      "changes existing files — to create this file, call "
                      "write_file with the full content.")
    if os.path.isdir(path):
        return _error(rel, f"[Edit Error] Path is a directory: {path}")
    if _special(path):
        return _not_regular(rel, path)
    size = os.path.getsize(path)
    if size > LARGE_BYTES:
        return _summary(rel, size)
    data = _read(path)
    if b"\0" in data[:BINARY_SNIFF]:
        return _summary(rel, len(data))
    content, _ = decode_text(data)
    updated, err = apply_edit(content, old, new)
    if err:
        return _error(rel, err)
    return unified_diff(content, updated, path)


def _preview_write(path: str, rel: str, args: dict) -> Diff:
    content = args.get("content")
    if not isinstance(content, str):
        return _error(rel, "`content` must be a string")
    if os.path.isdir(path):
        return _error(rel, f"[File Error] Path is a directory: {path}")
    if _special(path):
        return _not_regular(rel, path)
    exists = os.path.exists(path)
    new_size = len(content.encode("utf-8", errors="replace"))
    if exists:
        size = os.path.getsize(path)
        if new_size > LARGE_BYTES:
            return _summary(rel, new_size)
        if size > LARGE_BYTES:
            return _summary(rel, size)
        data = _read(path)
        if b"\0" in data[:BINARY_SNIFF]:
            return _summary(rel, len(data))
        old, _ = decode_text(data)
    else:
        if new_size > LARGE_BYTES:
            return _summary(rel, new_size, created=True)
        old = ""
    d = unified_diff(old, content, path)
    d.created = not exists
    return d
