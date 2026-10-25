"""The tool set of `aihub-code` and the runner that executes the model's calls.

Permissions are decided before the runner is called; the runner only executes.
It must never raise: small local models send sloppy arguments.
"""
import copy
import logging
import os
import stat
from typing import Callable

from aihub.mcp_client import schemas_for_agent
from aihub.tools import TOOLS_SCHEMA
from .engine.file_ops import decode_text
from .engine.tools import run_tool
from aihub.tools.workdir import resolve, workdir
from .checkpoints import CheckpointStore
from .diffs import preview
from .shell import run_shell
from .todo import TODO_SCHEMA, TodoList

log = logging.getLogger(__name__)

EDIT_HINT = (" Re-read the file with read_file, then copy the exact text "
             "(whitespace included) into `old`.")
DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 900
DEFAULT_LIMIT = 400
MAX_LIMIT = 2000
MAX_READ_BYTES = 2_000_000
_NOT_FOUND = "[Edit Error] `old` text not found"


def read_numbered(path: str, offset: int = 1, limit: int = DEFAULT_LIMIT) -> str:
    """Lines of a file, each prefixed with its number, for read-then-edit."""
    path = resolve(path)
    if not os.path.exists(path):
        return f"[File Error] File not found: {path}"
    if os.path.isdir(path):
        from .engine.file_ops import list_files
        return (f"{path} is a directory, not a file. Its contents (read one of "
                f"these files, or use list_files):\n" + list_files(path))
    try:
        if not stat.S_ISREG(os.stat(path).st_mode):
            return f"[File Error] {path} is not a regular file (a device, pipe or socket); not read."
        with open(path, "rb") as f:
            data = f.read(MAX_READ_BYTES + 1)
    except Exception as e:
        return f"[File Error] Could not read file: {e}"
    if b"\x00" in data[:8192]:
        return f"[File Error] {path} looks like a binary file; not shown."
    capped = len(data) > MAX_READ_BYTES
    if capped:
        data = data[:MAX_READ_BYTES]
        data = data[:data.rfind(b"\n") + 1] or data     # whole lines only
    lines = decode_text(data)[0].splitlines()
    total = len(lines)
    offset = max(1, offset)
    limit = max(1, min(limit, MAX_LIMIT))
    big = (f"{path} is larger than 2 MB; read_file shows only its first {total} lines. "
           "Use search_files, or run_terminal with sed -n 'FROM,TOp' for later lines.")
    if total == 0:
        return "(empty file)"
    if offset > total:
        return f"[File Error] {big}" if capped else f"[File Error] {path} has only {total} lines."
    end = min(total, offset - 1 + limit)
    out = "\n".join(f"{n:>5}\t{lines[n - 1]}" for n in range(offset, end + 1))
    if capped:
        out += f"\n[lines {offset}-{end} — {big}]"
    elif end < total:
        out += f"\n[lines {offset}-{end} of {total} — call read_file with offset to read more]"
    return out


def _schema(name: str) -> dict:
    for t in TOOLS_SCHEMA:
        if t["function"]["name"] == name:
            return copy.deepcopy(t)
    raise KeyError(name)


def code_tools_schema(mcp_entries: list[str] | None = None,
                      kb_schema: dict | None = None) -> list[dict]:
    read = {"type": "function", "function": {
        "name": "read_file",
        "description": ("Read a text file. Lines come back numbered (the numbers are not "
                        f"part of the file). Shows up to {DEFAULT_LIMIT} lines from `offset`; "
                        "read more with a larger offset."),
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Absolute or relative path to the file."},
            "offset": {"type": "integer", "description": "First line to show (default 1)."},
            "limit": {"type": "integer",
                      "description": f"Lines to show (default {DEFAULT_LIMIT}, max {MAX_LIMIT})."},
        }, "required": ["path"]}}}
    term = _schema("run_terminal")
    term["function"]["parameters"]["properties"]["timeout"] = {
        "type": "integer",
        "description": (f"Timeout in seconds (default {DEFAULT_TIMEOUT}, max {MAX_TIMEOUT}). "
                        "Raise it for slow builds and test runs.")}
    schema = [read, _schema("edit_file"), _schema("write_file"), _schema("search_files"),
              _schema("list_files"), term, copy.deepcopy(TODO_SCHEMA)]
    schema += schemas_for_agent(list(mcp_entries or []))
    if kb_schema:
        schema.append(kb_schema)
    return schema


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


class CodeToolRunner:
    def __init__(self, *, todo: TodoList, checkpoints: CheckpointStore,
                 emit: Callable[[str, dict], None], cancel_check: Callable[[], bool],
                 budget: int):
        self.todo = todo
        self.checkpoints = checkpoints
        self.emit = emit
        self.cancel_check = cancel_check
        self.budget = budget

    def _emit(self, kind: str, data: dict) -> None:
        try:
            self.emit(kind, data)
        except Exception as e:
            log.warning("emit %s failed: %s", kind, e)

    def __call__(self, name: str, args: dict) -> str:
        try:
            return self._run(name, args if isinstance(args, dict) else {})
        except Exception as e:
            return f"[Tool Error] '{name}' failed: {e}"

    def _run(self, name: str, args: dict) -> str:
        needs = {"todo_write": "todos", "run_terminal": "command", "read_file": "path",
                 "write_file": "path", "edit_file": "path"}.get(name)
        if needs and args.get(needs) is None:
            return f"[Tool Error] {name} needs '{needs}'."
        if name == "todo_write":
            result = self.todo.write(args["todos"])
            self._emit("code_todos", {"todos": self.todo.items})
            return result
        if name == "run_terminal":
            cmd = str(args["command"])
            try:
                self.checkpoints.note_shell(cmd)
            except Exception as e:
                log.warning("note_shell failed: %s", e)
            return run_shell(cmd, cwd=workdir(),
                             timeout=_int(args.get("timeout") or DEFAULT_TIMEOUT, DEFAULT_TIMEOUT),
                             cancel_check=self.cancel_check, budget=self.budget)
        if name == "read_file":
            return read_numbered(str(args["path"]), _int(args.get("offset"), 1),
                                 _int(args.get("limit"), DEFAULT_LIMIT))
        if name in ("write_file", "edit_file"):
            try:
                self.checkpoints.record_before(resolve(str(args["path"])))
            except Exception as e:
                log.warning("record_before failed: %s", e)
            try:
                d = preview(name, args)
            except Exception as e:
                log.warning("preview failed: %s", e)
                d = None
            r = run_tool(name, **args)
            if r.startswith(_NOT_FOUND):
                r += EDIT_HINT
            if "Error]" not in r and d and not d.error:
                self._emit("code_diff", d.to_dict())
            return r
        return run_tool(name, **args)
