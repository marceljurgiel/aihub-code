"""
`aihub-code -p "task"` — one coding turn in the current folder, no UI.
For scripts and CI: exit codes and the JSON object are the contract.

Exit codes: 0 done, 1 fatal error, 2 bad input / not ready / project busy,
3 stopped at the tool-round limit, 130 interrupted.
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
from typing import Any, Dict, List, Optional

from .engine.filelock import LockBusy, try_file_lock
from .permissions import PLAN_DENIAL
from .project import find_root, store_dir
from .session import MODES, CodeSession, run_turn

OUTPUTS = ("text", "json")
ROUND_LIMIT_MARK = "[Stopped after"
BUSY_MESSAGE = "Another aihub-code session is working in this project."
REFUSED_HINT = ("Some actions were refused: nobody can approve them in a -p run. "
                "Use --mode auto, or add project rules.")


def _progress(stream, glyph: str, ascii_form: str, rest: str) -> None:
    """One progress line; falls back to ASCII on a console that can't print
    the glyph (Windows cp1252 / cp437)."""
    line = f"{glyph} {rest}\n"
    try:
        enc = getattr(stream, "encoding", None)
        if enc:
            line.encode(enc)
        stream.write(line)
    except (UnicodeEncodeError, LookupError):
        try:
            stream.write(f"{ascii_form} {rest}\n".encode("ascii", "replace").decode("ascii"))
        except Exception:
            return
    except Exception:
        return
    try:
        stream.flush()
    except Exception:
        pass


def _write_out(stream, payload: str) -> None:
    """Write the result; never die on an unencodable character or a closed pipe."""
    try:
        try:
            stream.write(payload)
        except UnicodeEncodeError:
            enc = getattr(stream, "encoding", None) or "ascii"
            data = payload.encode(enc, errors="replace")
            buf = getattr(stream, "buffer", None)
            if buf is not None:
                stream.flush()
                buf.write(data)
            else:
                stream.write(data.decode(enc, errors="replace"))
        stream.flush()
    except BrokenPipeError:
        pass


def _short_args(args: Any) -> str:
    if not isinstance(args, dict):
        return ""
    for key in ("path", "command", "pattern"):
        if args.get(key):
            return " ".join(str(args[key]).split())[:60]
    return ""


def _install_handlers(handler) -> dict:
    """SIGTERM/SIGHUP → `handler`; returns the previous handlers. Only the
    main thread can set handlers; elsewhere nothing changes."""
    previous = {}
    for name in ("SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            previous[sig] = signal.signal(sig, handler)
        except (ValueError, OSError):
            pass
    return previous


def _restore_handlers(previous: dict) -> None:
    for sig, handler in previous.items():
        try:
            signal.signal(sig, handler if handler is not None else signal.SIG_DFL)
        except (ValueError, OSError, TypeError):
            pass


def _is_denied(result: Any) -> bool:
    text = str(result or "")
    return text == PLAN_DENIAL or text.startswith("Refused:")


def run_headless(task: str, *, mode: str = "build", model: Optional[str] = None,
                 output: str = "text", cwd: Optional[str] = None,
                 mcp: Optional[List[str]] = None, knowledge: Optional[List[str]] = None,
                 stdout=None, stderr=None, stream_fn=None) -> int:
    stdout = stdout if stdout is not None else sys.stdout
    stderr = stderr if stderr is not None else sys.stderr
    from aihub.config import config
    model = model or config.default_chat_model
    state: Dict[str, Any] = {"text": "", "session": "", "denied": 0, "rounds": 0,
                             "files": [], "todos": [], "usage": None, "error": ""}

    def finish(code: int, text: str, ok: bool) -> int:
        """Print the result and return `code`. `ok` = there is an answer to
        print in text mode (a round-limit stop has one); JSON `ok` is
        exit_code == 0."""
        if output == "json":
            payload = json.dumps({
                "ok": code == 0, "text": text, "model": model, "mode": mode,
                "session": state["session"], "files_changed": state["files"],
                "denied": state["denied"], "todos": state["todos"],
                "rounds": state["rounds"], "usage": state["usage"], "exit_code": code,
            }, ensure_ascii=False) + "\n"
        elif ok:
            payload = text + ("\n" if not text.endswith("\n") else "")
        else:
            return code
        _write_out(stdout, payload)
        return code

    def bad(message: str) -> int:
        stderr.write(message + "\n")
        stderr.flush()
        return finish(2, message, False)

    if output not in OUTPUTS:
        return bad(f"unknown output {output!r}; use one of {', '.join(OUTPUTS)}")
    if mode not in MODES:
        return bad(f"unknown mode {mode!r}; use one of {', '.join(MODES)}")
    if stream_fn is None:
        from aihub.ollama_client import get_local_models, is_ollama_running
        if not is_ollama_running():
            return bad("Ollama is not running. Start it, then try again.")
        names = {str(m) for m in get_local_models()}
        if not names:
            return bad("Could not list the models on the Ollama server (or none are installed).")
        if not (model in names or (":" not in model and f"{model}:latest" in names)):
            return bad(f"Model {model!r} is not installed. Install it or pass --model.")
        from .backends import resolve_stream_fn
        stream_fn = resolve_stream_fn(model, "ollama")

    try:
        root, _ = find_root(cwd or ".")
        with try_file_lock(os.path.join(store_dir(root), "session.lock")):
            return _run_locked(task, model, mode, mcp, knowledge, cwd, stream_fn,
                               state, stderr, finish)
    except LockBusy:
        return bad(BUSY_MESSAGE)


def _run_locked(task, model, mode, mcp, knowledge, cwd, stream_fn, state, stderr, finish) -> int:
    try:
        session = CodeSession.start(cwd or ".", model, backend="ollama", mode=mode,
                                    mcp=list(mcp or []), knowledge=list(knowledge or []))
    except Exception as e:
        stderr.write(f"{e}\n")
        return finish(1, str(e), False)
    state["session"] = session.id

    def emit(event: str, data: dict) -> None:
        if event == "tool_call":
            _progress(stderr, "→", "->", f"{data.get('name', '')} {_short_args(data.get('arguments'))}".rstrip())
        elif event == "tool_result":
            if _is_denied(data.get("result")):
                state["denied"] += 1
                _progress(stderr, "✗", "x", f"refused {data.get('name', '')}")
        elif event == "round":
            state["rounds"] += 1
        elif event == "usage":
            state["usage"] = {"prompt_tokens": data.get("prompt_tokens", 0),
                              "completion_tokens": data.get("completion_tokens", 0)}
        elif event == "code_diff":
            p = data.get("path")
            if p and p not in state["files"]:
                state["files"].append(p)
        elif event == "code_todos":
            state["todos"] = data.get("todos", data.get("items", state["todos"]))
        elif event == "chat_error" and data.get("fatal"):
            state["error"] = data.get("message", "") or state["error"]

    cancel = threading.Event()
    result: Dict[str, Any] = {}

    def work() -> None:
        try:
            result["outcome"] = run_turn(session, task, emit=emit, ask=None, cancel=cancel,
                                         stream_fn=stream_fn)
        except BaseException as e:      # reported below, never lost in the thread
            result["exc"] = e

    def terminate(signum, frame) -> None:
        # `kill` or a closed terminal: commands die now, the turn winds down.
        from .shell import kill_all
        cancel.set()
        kill_all()
        raise KeyboardInterrupt

    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    interrupted = False
    previous = _install_handlers(terminate)
    try:
        while worker.is_alive():
            try:
                worker.join()
            except KeyboardInterrupt:
                interrupted = True
                cancel.set()
    finally:
        _restore_handlers(previous)
    if interrupted:
        stderr.write("Interrupted.\n")
        return finish(130, "Interrupted.", False)
    if mode == "build" and state["denied"]:
        _progress(stderr, "!", "!", REFUSED_HINT)

    if "exc" in result:
        msg = str(result["exc"]) or type(result["exc"]).__name__
        stderr.write(msg + "\n")
        return finish(1, msg, False)
    outcome = result["outcome"]
    err = outcome.error or ""
    if err:
        stderr.write(err + "\n")
        return finish(1, err, False)
    if outcome.cancelled:
        stderr.write("Cancelled.\n")
        return finish(130, outcome.final_text or "Cancelled.", False)
    text = outcome.final_text or ""
    if ROUND_LIMIT_MARK in text:
        return finish(3, text, True)
    return finish(0, text, True)
