"""The bridge serves all of AIhub's engine: methods, streams, cancel, permission."""
from __future__ import annotations

import json
import os
import queue
import threading
import time

import pytest

from aihub_code import bridge


@pytest.fixture
def wire(monkeypatch):
    lines = []
    monkeypatch.setattr(bridge, "_send", lambda obj: lines.append(obj))
    monkeypatch.setattr(bridge, "_code", None)
    monkeypatch.setattr(bridge, "_code_busy", False)
    return lines


def _wait(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def _req(method, params=None, req_id=1):
    bridge._dispatch(json.dumps({"id": req_id, "method": method, "params": params or {}}))


def test_every_aihub_oneshot_is_routed(wire):
    from aihub import bridge as ab
    handlers = bridge._handlers()
    for name in list(ab._ONESHOT) + list(ab._STREAMING):
        if name == "workdir.set":
            assert name not in handlers
        else:
            assert name in handlers, name
    bridge._run(3, "workdir.set", {"path": "/"})
    assert "not available in aihub-code" in wire[-1]["error"]


def test_delegated_stream_events_reach_protocol(wire, monkeypatch, capsys):
    from aihub import bridge as ab

    def fake(req_id, p):
        ab._emit(req_id, "progress", {"n": 1})
        ab._done(req_id, {"ok": True})

    monkeypatch.setitem(ab._STREAMING, "kb.sync", fake)
    bridge._run(7, "kb.sync", {})
    assert wire == [{"id": 7, "event": "progress", "data": {"n": 1}},
                    {"id": 7, "done": True, "data": {"ok": True}}]
    assert capsys.readouterr().err == ""
    assert 7 not in bridge._delegated


def _blocking_stream(ab, monkeypatch, name, registry):
    started = threading.Event()
    got = {}

    def fake(req_id, p):
        obj = threading.Event() if registry == "_cancel_events" else queue.Queue()
        with ab._reg_lock:
            getattr(ab, registry)[req_id] = obj
        started.set()
        try:
            if registry == "_cancel_events":
                got["fired"] = obj.wait(5)
                ab._done(req_id, {"cancelled": got["fired"]})
            else:
                got["item"] = obj.get(timeout=5)
                ab._done(req_id, {"item": got["item"]})
        finally:
            with ab._reg_lock:
                getattr(ab, registry).pop(req_id, None)

    monkeypatch.setitem(ab._STREAMING, name, fake)
    return started, got


def test_cancel_routes_to_aihub_registry(wire, monkeypatch):
    from aihub import bridge as ab
    started, got = _blocking_stream(ab, monkeypatch, "kb.sync", "_cancel_events")
    _req("kb.sync", req_id=11)
    assert started.wait(5)
    _req("chat.cancel", {"request_id": 11}, req_id=None)
    assert _wait(lambda: any(m.get("done") for m in wire))
    assert wire[-1] == {"id": 11, "done": True, "data": {"cancelled": True}}
    _req("ping", req_id=12)
    assert _wait(lambda: any(m.get("id") == 12 and m.get("done") for m in wire))


def test_cancel_right_after_start_reaches_aihub(wire, monkeypatch):
    """A cancel sent right after the request, before AIhub's handler has
    registered its cancel event, still sets that event."""
    from aihub import bridge as ab
    got = {}

    def slow(req_id, p):
        time.sleep(0.2)     # the thread starts, but the event isn't there yet
        ev = threading.Event()
        with ab._reg_lock:
            ab._cancel_events[req_id] = ev
        try:
            got["fired"] = ev.wait(2)
            ab._done(req_id, {"cancelled": got["fired"]})
        finally:
            with ab._reg_lock:
                ab._cancel_events.pop(req_id, None)

    monkeypatch.setitem(ab._STREAMING, "kb.sync", slow)
    _req("kb.sync", req_id=13)
    _req("chat.cancel", {"request_id": 13}, req_id=None)
    assert _wait(lambda: any(m.get("done") for m in wire))
    assert got["fired"] is True
    assert wire[-1] == {"id": 13, "done": True, "data": {"cancelled": True}}
    assert _wait(lambda: 13 not in bridge._delegated)


def test_permission_routes_to_aihub_queue(wire, monkeypatch):
    from aihub import bridge as ab
    started, got = _blocking_stream(ab, monkeypatch, "kb.sync", "_perm_queues")
    _req("kb.sync", req_id=21)
    assert started.wait(5)
    _req("chat.permission", {"request_id": 21, "allow": True}, req_id=None)
    assert _wait(lambda: any(m.get("done") for m in wire))
    assert got["item"] is True


def test_shutdown_cancels_delegated_streams(wire, monkeypatch):
    from aihub import bridge as ab
    started, got = _blocking_stream(ab, monkeypatch, "kb.sync", "_cancel_events")
    _req("kb.sync", req_id=31)
    assert started.wait(5)
    bridge._cancel_delegated()
    assert _wait(lambda: any(m.get("done") for m in wire))
    assert got["fired"] is True


def test_workdir_is_project_folder(wire, monkeypatch, tmp_path):
    from aihub.tools import workdir
    monkeypatch.setattr(bridge, "_aihub_mod", None)
    monkeypatch.setattr(workdir, "_session_dir", "")
    monkeypatch.chdir(tmp_path)
    bridge._run(1, "ping", {})
    bridge._aihub()
    assert workdir.workdir() == os.path.realpath(tmp_path) or workdir.workdir() == str(tmp_path)
