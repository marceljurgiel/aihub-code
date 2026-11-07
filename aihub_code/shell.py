"""Long-running, cancellable shell for coding sessions.

Unlike ``aihub.tools.terminal.run_terminal`` this one can run for minutes,
dies with its whole process tree on timeout or cancel, closes stdin, and keeps
the head and the tail of long output (build and test failures sit at the end).
Running commands are registered, so ``kill_all`` can end them all when the
process exits (bridge shutdown, a terminated ``aihub-code -p``).
"""
import codecs
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from typing import Callable

from aihub.tools.terminal import _powershell_script

log = logging.getLogger(__name__)

_HEAD = 1500
_POLL = 0.2

_live: set = set()            # Popen objects of the commands running now
_live_lock = threading.Lock()


class _Collector:
    """Keeps the first _HEAD chars, a rolling tail and the running total."""

    def __init__(self, budget: int):
        self.budget = budget
        self.head = ""
        self.tail = ""
        self.total = 0
        self._lock = threading.Lock()

    def add(self, text: str) -> None:
        if not text:
            return
        with self._lock:
            self._add(text)

    def _add(self, text: str) -> None:
        self.total += len(text)
        if len(self.head) < _HEAD:
            self.head += text[: _HEAD - len(self.head)]
        self.tail += text
        if len(self.tail) > 2 * self.budget:
            self.tail = self.tail[-self.budget:]

    def result(self) -> str:
        with self._lock:
            return self._result()

    def _result(self) -> str:
        if self.total <= self.budget:
            return self.tail[-self.total:] if self.total else ""
        omitted = self.total - self.budget
        return (self.head[:_HEAD] + f"\n… [{omitted} chars omitted] …\n"
                + self.tail[-(self.budget - _HEAD):])


def _read(pipe, col: _Collector) -> None:
    dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
    try:
        while True:
            chunk = os.read(pipe.fileno(), 65536)
            if not chunk:
                break
            col.add(dec.decode(chunk))
        col.add(dec.decode(b"", final=True))
    except (OSError, ValueError):
        pass


def _kill_tree(proc: subprocess.Popen) -> None:
    if sys.platform == "win32":
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                           capture_output=True, timeout=10)
        except Exception as e:
            log.warning("taskkill failed for pid %s: %s", proc.pid, e)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        proc.kill()
    except OSError:
        pass


def kill_all() -> None:
    """Kill every running command with its process tree. Never raises."""
    with _live_lock:
        procs = list(_live)
    for proc in procs:
        try:
            if proc.poll() is None:
                _kill_tree(proc)
        except Exception as e:
            log.warning("could not kill pid %s: %s", getattr(proc, "pid", "?"), e)


def _clamp_timeout(timeout: int, max_timeout: int) -> int:
    return max(1, min(int(timeout), max_timeout))


def run_shell(command: str, *, cwd: str, timeout: int = 120, max_timeout: int = 900,
              cancel_check: Callable[[], bool] | None = None, budget: int = 8000) -> str:
    timeout = _clamp_timeout(timeout, max_timeout)
    budget = max(budget, _HEAD + 1)
    env = dict(os.environ, CI="1", GIT_PAGER="cat", PAGER="cat")
    kwargs: dict = {}
    if sys.platform == "win32":
        argv = ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                _powershell_script(command)]
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        argv = ["/bin/sh", "-c", command]
        kwargs["start_new_session"] = True
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
    except Exception as e:
        return f"[Error: {e}]\n[Exit: 1]"
    with _live_lock:
        _live.add(proc)

    col = _Collector(budget)
    reader = threading.Thread(target=_read, args=(proc.stdout, col), daemon=True)
    reader.start()

    deadline = time.monotonic() + timeout
    status = None
    killed = False
    try:
        while True:
            try:
                proc.wait(timeout=_POLL)
                break
            except subprocess.TimeoutExpired:
                pass
            if cancel_check is not None and cancel_check():
                status = "CANCELLED"
            elif time.monotonic() >= deadline:
                status = "TIMEOUT"
            if status:
                _kill_tree(proc)
                killed = True
                break
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    finally:
        with _live_lock:
            _live.discard(proc)
        if proc.poll() is None and not killed:
            _kill_tree(proc)
            killed = True
        # A grandchild may still hold the pipe; don't wait for it long.
        reader.join(2 if killed else 0.3)
        # Decide before closing: on macOS the close wakes the blocked read and
        # the reader ends at once.
        orphaned = not killed and reader.is_alive()
        try:
            proc.stdout.close()
        except OSError:
            pass

    out = col.result()
    if orphaned:
        out += "\n[Background output not captured]"
    return f"{out}\n[Exit: {status or proc.returncode}]"
