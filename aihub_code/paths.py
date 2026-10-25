"""Path guards for the coding harness: is a path inside the project root?"""
from __future__ import annotations

import os


def _norm(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def inside_root(path: str, root: str) -> bool:
    """True when `path` is `root` or lies under it. Symlinks are followed
    (also through the parent of a file that does not exist yet) and case is
    folded where the filesystem does so. Anything doubtful counts as outside."""
    try:
        r, p = _norm(root), _norm(path)
        return os.path.commonpath([r, p]) == r
    except (ValueError, OSError):
        return False


def in_git_dir(path: str, root: str) -> bool:
    """True when any component of `path` (relative to `root`, after resolving
    symlinks) is `.git`, compared case-insensitively on every OS. This covers
    nested repositories and case-insensitive filesystems."""
    if not inside_root(path, root):
        return False
    try:
        rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    except ValueError:
        return False
    return any(part.lower() == ".git" for part in rel.replace("\\", "/").split("/"))
