import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { BridgeClient, bridgeErrLogPath, resolveBridgeCmd } from "./client.ts";

test("default bridge argv", () => {
  expect(resolveBridgeCmd({})).toEqual(["python3", "-m", "aihub_code.bridge"]);
});

test("AIHUB_CODE_BRIDGE overrides the argv (JSON array)", () => {
  expect(resolveBridgeCmd({ AIHUB_CODE_BRIDGE: '["/x/python","-m","aihub_code.bridge"]' })).toEqual(["/x/python", "-m", "aihub_code.bridge"]);
});

test("a malformed AIHUB_CODE_BRIDGE falls back to the default", () => {
  for (const bad of ["not json", '{"a":1}', "[]", "[1,2]"]) {
    expect(resolveBridgeCmd({ AIHUB_CODE_BRIDGE: bad })).toEqual(["python3", "-m", "aihub_code.bridge"]);
  }
});

test("the error log is aihub-code's own file", () => {
  expect(bridgeErrLogPath({ AIHUB_CODE_ERR_LOG: "/tmp/x.log" })).toBe("/tmp/x.log");
  expect(bridgeErrLogPath({}, "/home/u")).toBe("/home/u/.aihub/aihub-code-bridge.err.log");
});

/** A tiny stand-in bridge: says ready, echoes calls, streams two events. */
function fakeBridge(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "fake-bridge-"));
  const script = join(dir, "bridge.py");
  writeFileSync(script, `
import sys, json
def out(o): print(json.dumps(o), flush=True)
out({"id": None, "event": "ready", "data": {"version": "9.9"}})
for line in sys.stdin:
    m = json.loads(line)
    if m["method"] == "boom":
        out({"id": m["id"], "error": "kaboom"})
    elif m["method"] == "stream":
        out({"id": m["id"], "event": "a", "data": {"n": 1}})
        out({"id": m["id"], "event": "b", "data": {"s": "\\u001b[31mred"}})
        out({"id": m["id"], "done": True, "data": {"end": True}})
    else:
        out({"id": m["id"], "done": True, "data": {"echo": m["params"]}})
`);
  return ["python3", script];
}

test("ready, call, error and stream against a fake bridge", async () => {
  const prev = process.env.AIHUB_CODE_BRIDGE;
  process.env.AIHUB_CODE_BRIDGE = JSON.stringify(fakeBridge());
  const b = new BridgeClient();
  try {
    b.start();
    expect(await b.ready()).toEqual({ version: "9.9" });
    expect(await b.call("echo", { x: 1 })).toEqual({ echo: { x: 1 } });
    await expect(b.call("boom")).rejects.toThrow("kaboom");

    const events: Array<[string, any]> = [];
    const s = b.stream("stream", {}, (e, d) => events.push([e, d]));
    expect(typeof s.cancel).toBe("function");
    expect(await s.done).toEqual({ end: true });
    // Control characters from the engine are neutralised before anything renders.
    expect(events).toEqual([["a", { n: 1 }], ["b", { s: "␛[31mred" }]]);

    // The stream form with a handlers object still works (AIhub's shape).
    const events2: string[] = [];
    await b.stream("stream", {}, { onEvent: (e) => events2.push(e) }).done;
    expect(events2).toEqual(["a", "b"]);
  } finally {
    b.destroy();
    if (prev === undefined) delete process.env.AIHUB_CODE_BRIDGE;
    else process.env.AIHUB_CODE_BRIDGE = prev;
  }
});

test("send and cancel write control messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-bridge-"));
  const log = join(dir, "got.jsonl");
  const script = join(dir, "bridge.py");
  writeFileSync(script, `
import sys, json
print(json.dumps({"id": None, "event": "ready", "data": {"version": "1"}}), flush=True)
f = open(${JSON.stringify(log)}, "a")
for line in sys.stdin:
    f.write(line); f.flush()
`);
  const prev = process.env.AIHUB_CODE_BRIDGE;
  process.env.AIHUB_CODE_BRIDGE = JSON.stringify(["python3", script]);
  const b = new BridgeClient();
  try {
    b.start();
    await b.ready();
    const s = b.stream("code.turn", {}, () => {});
    s.cancel();
    b.send({ method: "chat.permission", params: { request_id: s.id, allow: true } });
    for (let i = 0; i < 50 && readFileSync(log, "utf8").split("\n").filter(Boolean).length < 3; i++) await Bun.sleep(40);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[1]).toEqual({ method: "chat.cancel", params: { request_id: s.id } });
    expect(lines[2]).toEqual({ method: "chat.permission", params: { request_id: s.id, allow: true } });
  } finally {
    b.destroy();
    if (prev === undefined) delete process.env.AIHUB_CODE_BRIDGE;
    else process.env.AIHUB_CODE_BRIDGE = prev;
  }
});
