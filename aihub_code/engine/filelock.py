"""
AIhub — a lock shared by the bridge's request threads and by other AIhub
windows: a thread lock plus an OS file lock (fcntl / msvcrt) on a lock file.
"""
from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Dict, Iterator

_thread_locks: Dict[str, threading.RLock] = {}
_guard = threading.Lock()
_held = threading.local()      # paths this thread holds, with their depth


def _thread_lock(path: str) -> threading.RLock:
    with _guard:
        return _thread_locks.setdefault(os.path.abspath(path), threading.RLock())


@contextmanager
def file_lock(path: str) -> Iterator[None]:
    """Hold `path` (created if missing) exclusively until the block ends.
    Re-entrant within a thread; waits for other threads and processes."""
    key = os.path.abspath(path)
    with _thread_lock(path):
        depth = getattr(_held, "d", {})
        _held.d = depth
        if depth.get(key):
            # Already ours: a second OS lock on a new handle would wait for
            # the first one, held by this very thread.
            depth[key] += 1
            try:
                yield
            finally:
                depth[key] -= 1
            return
        depth[key] = 1
        try:
            with _os_lock(path):
                yield
        finally:
            depth[key] = 0


@contextmanager
def _os_lock(path: str) -> Iterator[None]:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a+b") as f:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            while True:              # LK_LOCK gives up after ~10 s; keep waiting
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    continue
            try:
                yield
            finally:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)


class LockBusy(Exception):
    """Another holder has the lock (raised by `try_file_lock`)."""


@contextmanager
def try_file_lock(path: str) -> Iterator[None]:
    """Like `file_lock`, but never waits: raises `LockBusy` when the lock is
    held, by another process or by another handle in this one."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a+b") as f:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as e:
                raise LockBusy(path) from e
            try:
                yield
            finally:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as e:
                raise LockBusy(path) from e
            try:
                yield
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
