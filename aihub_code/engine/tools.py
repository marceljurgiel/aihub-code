"""Tool dispatch for aihub-code.

Same contract as `aihub.tools.run_tool`, but `edit_file` and `write_file` run
aihub-code's own byte-preserving versions (engine/file_ops.py). AIhub 1.5.0's
versions re-encode files, so the diff preview would no longer match what is
written (ruling R13). Every other tool goes to AIhub unchanged.
"""
from __future__ import annotations

from typing import Callable, Dict

from aihub import tools as _aihub_tools
from .file_ops import edit_file, write_file

# Tools whose implementation aihub-code owns.
LOCAL_TOOLS: Dict[str, Callable[..., str]] = {
    "edit_file": edit_file,
    "write_file": write_file,
}


def run_tool(name: str, **kwargs) -> str:
    """Run a tool by name and return its output as a string; never raises."""
    fn = LOCAL_TOOLS.get(name)
    if fn is None:
        return _aihub_tools.run_tool(name, **kwargs)
    try:
        kwargs = _aihub_tools._fit_arguments(fn, kwargs)
        return str(fn(**kwargs))
    except TypeError as e:
        return (f"[Tool Error] Bad arguments for '{name}': {e}. "
                f"It takes: {_aihub_tools._signature_hint(fn)}. Call it again with those.")
    except Exception as e:
        return f"[Tool Error] '{name}' failed: {e}"
