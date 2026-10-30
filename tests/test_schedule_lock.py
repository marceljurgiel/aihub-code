"""Two aihub-code windows share ~/.aihub: a due scheduled task runs in one only.

AIhub's engine keeps the lock (aihub.schedule.claim under an OS file lock on
~/.aihub/schedule/.lock); aihub-code only delegates schedule.run to it. This
starts two real bridge subprocesses on one throwaway HOME and sends both the
same due slot within a second: exactly one runs it, the other gets AIhub's
"already ran" result.

No model is called: each subprocess starts from a test-only bootstrap (BOOT,
below) that swaps AIhub's backend stream for a slow fake before the bridge's
main loop. Nothing in aihub-code or the engine has a hook for this.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta

BOOT = r"""
import time
import aihub.agents
import aihub.bridge
import aihub.ollama_client

def fake_stream(*args, **kwargs):
    def gen():
        time.sleep(1.0)      # long enough for the other window's request to arrive meanwhile
        yield {"message": {"content": "hi"}}
    return gen()

aihub.bridge._resolve_stream_fn = lambda model, backend: fake_stream
aihub.ollama_client.is_ollama_running = lambda *a, **k: True
aihub.agents.agent_context = lambda *a, **k: (4096, "test")

from aihub_code.bridge import main
main()
"""


class Bridge:
    def __init__(self, home: str, cwd: str) -> None:
        env = {**os.environ, "HOME": home, "USERPROFILE": home}
        self.p = subprocess.Popen([sys.executable, "-c", BOOT], cwd=cwd, env=env, text=True,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL)
        assert self.p.stdin and self.p.stdout
        self.lines: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        try:
            self.ready = self.next(lambda m: m.get("event") == "ready")
        except BaseException:
            self.close()
            raise

    def _read(self) -> None:
        assert self.p.stdout
        for line in self.p.stdout:
            line = line.strip()
            if line:
                self.lines.put(json.loads(line))

    def next(self, pred, timeout: float = 20.0) -> dict:
        end = time.monotonic() + timeout
        while True:
            m = self.lines.get(timeout=max(0.01, end - time.monotonic()))
            if pred(m):
                return m

    def send(self, req_id: int, method: str, params: dict) -> None:
        assert self.p.stdin
        self.p.stdin.write(json.dumps({"id": req_id, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()

    def call(self, req_id: int, method: str, params: dict) -> dict:
        self.send(req_id, method, params)
        m = self.next(lambda m: m.get("id") == req_id and ("done" in m or "error" in m))
        assert "error" not in m, m
        return m["data"]

    def run(self, req_id: int) -> dict:
        """A schedule.run's events and its end."""
        events, end = [], None
        while end is None:
            m = self.next(lambda m: m.get("id") == req_id)
            if "event" in m:
                events.append(m["event"])
            else:
                end = m
        return {"events": events, "end": end}

    def close(self) -> None:
        try:
            if self.p.stdin:
                self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def test_two_windows_run_a_due_task_once(tmp_path):
    home, proj = tmp_path / "home", tmp_path / "proj"
    (home / ".aihub").mkdir(parents=True)
    proj.mkdir()
    # Nothing listens here: no request may reach a real Ollama.
    (home / ".aihub" / "config.yaml").write_text("ollama_api_url: http://127.0.0.1:9\n")
    started: list = []
    try:
        # Inside the try: if the second fails to start, the first is closed too.
        started.append(Bridge(str(home), str(proj)))
        started.append(Bridge(str(home), str(proj)))
        a, b = started
        created = (datetime.now() - timedelta(hours=1)).replace(microsecond=0).isoformat()
        a.call(1, "schedule.save", {"task": {
            "name": "daily", "agent": "writer", "model": "tiny:latest", "backend": "ollama",
            "stream_model": "tiny:latest", "when": "every 5m", "prompt": "say hi",
            "enabled": True, "created": created}})
        due = a.call(2, "schedule.check", {"startup": False})["due"]
        assert [d["name"] for d in due] == ["daily"]
        slot = due[0]["slot"]

        t0 = time.monotonic()
        a.send(10, "schedule.run", {"name": "daily", "slot": slot})
        b.send(10, "schedule.run", {"name": "daily", "slot": slot})
        assert time.monotonic() - t0 < 1.0
        ra, rb = a.run(10), b.run(10)
    finally:
        for br in started:
            br.close()

    results = sorted([ra, rb], key=lambda r: r["end"].get("data", {}).get("status", ""))
    ran, skipped = results[0], results[1]
    assert ran["end"]["data"]["status"] == "ok", ran
    assert "task" in ran["events"] and "text" in ran["events"]
    assert skipped["end"]["data"] == {"status": "skipped", "summary": "already ran in another AIhub window",
                                      "session": None}
    assert skipped["events"] == []
    state = json.loads((home / ".aihub" / "schedule" / "state.json").read_text())
    assert state["daily"]["last_status"] == "ok"
