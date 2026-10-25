"""Project root, instruction files and git summary for the coding harness."""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
from dataclasses import dataclass, field

INSTRUCTION_FILES = ("AGENTS.md", "CLAUDE.md", "GEMINI.md")
MAX_DIRTY = 15
TRUNCATED = "\n[... truncated]"


@dataclass
class ProjectInfo:
    root: str
    key: str
    is_git: bool
    branch: str = ""
    dirty: list[str] = field(default_factory=list)
    dirty_total: int = 0
    instruction_file: str = ""
    instructions: str = ""


def project_key(root: str) -> str:
    real = os.path.normcase(os.path.realpath(root))
    slug = re.sub(r"[^a-z0-9]+", "-", os.path.basename(real.rstrip("/\\")).lower()).strip("-")[:32].strip("-")
    digest = hashlib.sha1(real.encode()).hexdigest()[:10]
    return f"{slug or 'project'}-{digest}"


def store_dir(root: str, create: bool = True) -> str:
    from aihub.config import CONFIG_DIR
    path = os.path.join(CONFIG_DIR, "projects", project_key(root))
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def find_root(cwd: str) -> tuple[str, bool]:
    start = os.path.realpath(cwd)
    cur = start
    while True:
        if os.path.exists(os.path.join(cur, ".git")):
            return cur, True
        parent = os.path.dirname(cur)
        if parent == cur:
            return start, False
        cur = parent


def _read_instructions(cwd: str, root: str, ctx: int) -> tuple[str, str]:
    cur = os.path.realpath(cwd)
    while True:
        for name in INSTRUCTION_FILES:
            path = os.path.join(cur, name)
            if os.path.isfile(path):
                try:
                    with open(path, "rb") as fh:
                        raw = fh.read()
                except OSError:
                    continue
                text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
                cap = min(6000, int(ctx * 0.12 * 4))
                if len(text) > cap:
                    text = text[:max(0, cap - len(TRUNCATED))] + TRUNCATED
                return name, text
        if cur == root:
            break
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return "", ""


def _git(root: str, *args: str) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", root, *args], capture_output=True, timeout=3, check=False,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.decode("utf-8", errors="replace")


def _git_summary(root: str) -> tuple[str, list[str], int]:
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    if branch is None:
        return "", [], 0
    status = _git(root, "status", "--porcelain=v1", "-z")
    paths: list[str] = []
    if status:
        parts = status.split("\0")
        i = 0
        while i < len(parts):
            entry = parts[i]
            i += 1
            if len(entry) < 4:
                continue
            paths.append(entry[3:])
            if entry[0] in "RC":  # rename/copy: the old path follows
                i += 1
    return branch.strip(), paths[:MAX_DIRTY], len(paths)


def detect(cwd: str, ctx: int) -> ProjectInfo:
    root, is_git = find_root(cwd)
    name, text = _read_instructions(cwd, root, ctx)
    info = ProjectInfo(root=root, key=project_key(root), is_git=is_git,
                       instruction_file=name, instructions=text)
    if is_git:
        info.branch, info.dirty, info.dirty_total = _git_summary(root)
    return info
