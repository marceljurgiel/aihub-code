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

async function withBridge(argv: string[], fn: (b: BridgeClient) => Promise<void>) {
  const prev = process.env.AIHUB_CODE_BRIDGE;
  process.env.AIHUB_CODE_BRIDGE = JSON.stringify(argv);
  const b = new BridgeClient();
  try {
    b.start();
    await fn(b);
  } finally {
    b.destroy();
    if (prev === undefined) delete process.env.AIHUB_CODE_BRIDGE;
    else process.env.AIHUB_CODE_BRIDGE = prev;
  }
}

test("ready() rejects when the bridge exits before the banner", async () => {
  await withBridge(["sh", "-c", "exit 3"], async (b) => {
    const err = await b.ready().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("code 3");
    expect(err!.message).toContain(bridgeErrLogPath());
    // A later ready() still rejects (it must not hang).
    await expect(b.ready()).rejects.toThrow("code 3");
  });
});

test("ready() rejects when the bridge command does not exist", async () => {
  await withBridge(["/nonexistent/python3", "-m", "aihub_code.bridge"], async (b) => {
    const err = await b.ready().then(() => null, (e: Error) => e);
    expect(err?.message).toContain(bridgeErrLogPath());
  });
});

test("pending requests and streams reject when the bridge dies, and later ones fail at once", async () => {
  const script = `import sys, json, os, time
print(json.dumps({"id": None, "event": "ready", "data": {"version": "1"}}), flush=True)
for line in sys.stdin:
    m = json.loads(line)
    if m["method"] == "die":
        os._exit(7)
`;
  const dir = mkdtempSync(join(tmpdir(), "fake-bridge-"));
  const file = join(dir, "bridge.py");
  writeFileSync(file, script);
  await withBridge(["python3", file], async (b) => {
    await b.ready();
    expect(b.deadError()).toBeNull();
    const events: string[] = [];
    const s = b.stream("code.turn", {}, (e) => events.push(e));
    const pending = b.call("never");
    const sRes = s.done.then(() => null, (e: Error) => e);
    const pRes = pending.then(() => null, (e: Error) => e);
    b.call("die").catch(() => {});
    expect((await sRes)?.message).toContain("code 7");
    expect((await pRes)?.message).toContain(bridgeErrLogPath());
    expect(b.deadError()?.message).toContain("code 7"); // lets a caller tell "gone" from an engine error
    // After the exit: immediate rejection, no write to a dead pipe, no hang.
    await expect(b.call("ping")).rejects.toThrow("code 7");
    await expect(b.stream("code.turn", {}, () => {}).done).rejects.toThrow("code 7");
    expect(() => b.send({ method: "chat.cancel", params: { request_id: 1 } })).not.toThrow();
  });
});

test("onDead hears a bridge that dies, once, with the error; never a close on purpose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-bridge-"));
  const file = join(dir, "bridge.py");
  writeFileSync(file, `import sys, json, os
print(json.dumps({"id": None, "event": "ready", "data": {"version": "1"}}), flush=True)
for line in sys.stdin:
    if json.loads(line)["method"] == "die":
        os._exit(5)
`);
  const heard: string[] = [];
  await withBridge(["python3", file], async (b) => {
    b.onDead((e) => heard.push(e.message));
    await b.ready();
    b.call("die").catch(() => {});
    for (let i = 0; i < 50 && heard.length === 0; i++) await Bun.sleep(20);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain("code 5");
  });
  const quiet: string[] = [];
  await withBridge(fakeBridge(), async (b) => {
    b.onDead((e) => quiet.push(e.message));
    await b.ready();
  }); // withBridge destroys it
  await Bun.sleep(100);
  expect(quiet).toEqual([]);
});

/** A bridge that cleans up after stdin closes, as aihub_code.bridge does
 *  (it kills the agent's shells): `cleanup` is Python run after EOF, with its
 *  temp folder in DIR. */
function closingBridge(cleanup: string): { argv: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-bridge-"));
  const file = join(dir, "bridge.py");
  writeFileSync(file, `import sys, json, os, time
DIR = ${JSON.stringify(dir)}
open(os.path.join(DIR, "pid"), "w").write(str(os.getpid()))
print(json.dumps({"id": None, "event": "ready", "data": {"version": "1"}}), flush=True)
for line in sys.stdin:
    pass
${cleanup}
`);
  return { argv: ["python3", file], dir };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("destroy() closes stdin and lets the bridge finish its cleanup (no kill straight away)", async () => {
  const { argv, dir } = closingBridge(`time.sleep(0.3)\nopen(os.path.join(DIR, "cleaned"), "w").write("yes")`);
  const marker = join(dir, "cleaned");
  await withBridge(argv, async (b) => {
    await b.ready();
  }); // destroy()
  for (let i = 0; i < 50; i++) {
    try {
      readFileSync(marker, "utf8");
      break;
    } catch {
      await Bun.sleep(40);
    }
  }
  expect(readFileSync(marker, "utf8")).toBe("yes");
});

test("destroy() kills a bridge that does not exit after the grace time", async () => {
  const { argv, dir } = closingBridge("time.sleep(60)");
  let pid = 0;
  await withBridge(argv, async (b) => {
    b.exitGraceMs = 150;
    await b.ready();
    pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  });
  expect(alive(pid)).toBe(true); // still in its grace time
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(40);
  expect(alive(pid)).toBe(false);
});
