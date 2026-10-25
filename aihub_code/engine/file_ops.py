"""
File operations for aihub-code: read, write, edit and list local files.

A copy of AIhub 1.5.0's aihub/tools/file_ops.py with byte-preserving edits
(CRLF endings and latin-1 survive) and write_file without newline
translation. aihub-code routes its edit_file / write_file here, so the diff
the user approves is exactly what gets written.
"""
from __future__ import annotations

import glob
import os
import stat

from aihub.tools.workdir import resolve


def read_file(path: str, max_lines: int = 200) -> str:
    """
    Read and return the contents of a local file.

    Args:
        path:      Path to the file (absolute or relative).
        max_lines: Maximum number of lines to return (default 200).

    Returns:
        File contents as a string (truncated if over max_lines),
        or an error message if the file cannot be read.
    """
    path = resolve(path)
    if not os.path.exists(path):
        return f"[File Error] File not found: {path}"
    if os.path.isdir(path):
        # Models often "read" a folder; show what's in it instead of failing.
        return (f"{path} is a directory, not a file. Its contents (read one of "
                f"these files, or use list_files):\n" + list_files(path))

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception as e:
        return f"[File Error] Could not read file: {e}"

    total = len(lines)
    truncated = lines[:max_lines]
    content = "".join(truncated)

    footer = ""
    if total > max_lines:
        footer = f"\n... [truncated: showing {max_lines} of {total} lines]"

    return f"```\n{content}{footer}\n```"


def write_file(path: str, content: str) -> str:
    """
    Write content to a local file, creating parent directories as needed.

    Args:
        path:    File path to write to.
        content: String content to write.

    Returns:
        Success or error message.
    """
    path = resolve(path)
    try:
        if os.path.exists(path) and not os.path.isdir(path) and not stat.S_ISREG(os.stat(path).st_mode):
            return f"[File Error] Not a regular file (a device, pipe or socket): {path}"
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        size = os.path.getsize(path)
        return f"[File OK] Written {size} bytes to: {path}"
    except Exception as e:
        return f"[File Error] Could not write file: {e}"


def apply_edit(content: str, old: str, new: str) -> tuple[str | None, str | None]:
    """Replace the one occurrence of `old` in `content`.

    Returns (updated, None) or (None, error_text). Shared by `edit_file` and the
    diff preview so both agree. A CRLF file matches an LF-only `old` (the model
    only ever sees LF); the replacement is converted to CRLF to match.
    """
    count = content.count(old)
    if (count == 0 and "\r\n" in content and "\n" in old
            and "\r\n" not in old):
        old2 = old.replace("\n", "\r\n")
        if content.count(old2):
            old, new = old2, new.replace("\r\n", "\n").replace("\n", "\r\n")
            count = content.count(old)
    if count == 0:
        return None, ("[Edit Error] `old` text not found in the file. It must match "
                      "exactly, including whitespace and indentation.")
    if count > 1:
        return None, (f"[Edit Error] `old` text appears {count} times — it must be "
                      "unique. Include more surrounding context to disambiguate.")
    return content.replace(old, new, 1), None


def decode_text(data: bytes) -> tuple[str, str]:
    """Decode UTF-8, else latin-1. Returns (text, encoding used)."""
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("latin-1"), "latin-1"


def edit_file(path: str, old: str, new: str) -> str:
    """
    Replace an exact string in a file (precise edit, like OpenCode's `edit`).
    Bytes outside the replaced text are preserved (CRLF endings, latin-1).

    Args:
        path: File to edit.
        old:  Exact text to find. Must appear exactly once.
        new:  Replacement text.

    Returns:
        Success or an error message ('not found' / 'not unique').
    """
    path = resolve(path)
    if not os.path.exists(path):
        return (f"[Edit Error] File not found: {path}. edit_file only changes "
                "existing files — to create this file, call write_file with the "
                "full content.")
    if os.path.isdir(path):
        return f"[Edit Error] Path is a directory: {path}"
    try:
        if not stat.S_ISREG(os.stat(path).st_mode):
            return f"[Edit Error] Not a regular file (a device, pipe or socket): {path}"
        with open(path, "rb") as f:
            content, enc = decode_text(f.read())
    except Exception as e:
        return f"[Edit Error] Could not read file: {e}"

    updated, err = apply_edit(content, old, new)
    if err:
        return err
    try:
        data = updated.encode(enc)
    except UnicodeEncodeError:
        return ("[Edit Error] The file is not UTF-8 (latin-1) and the new text "
                "has characters it cannot hold.")
    try:
        with open(path, "wb") as f:
            f.write(data)
    except Exception as e:
        return f"[Edit Error] Could not write file: {e}"
    return f"[Edit OK] Replaced 1 occurrence in {path}."


def list_files(directory: str, pattern: str = "*") -> str:
    """
    List files in a directory matching an optional glob pattern.

    Args:
        directory: Directory to list.
        pattern:   Glob pattern (default: '*' for all files).

    Returns:
        Newline-separated list of matching paths, or an error message.
    """
    directory = resolve(directory)
    if not os.path.exists(directory):
        return f"[File Error] Directory not found: {directory}"
    if not os.path.isdir(directory):
        return f"[File Error] Not a directory: {directory}"

    search_pattern = os.path.join(directory, pattern)
    try:
        matches = sorted(glob.glob(search_pattern))
    except Exception as e:
        return f"[File Error] Glob pattern error: {e}"

    if not matches:
        return f"[No files matched '{pattern}' in {directory}]"

    lines = []
    for p in matches:
        if os.path.isdir(p):
            lines.append(f"  📁  {p}/")
        else:
            size = os.path.getsize(p)
            lines.append(f"  📄  {p}  ({size} bytes)")

    return "\n".join(lines)
