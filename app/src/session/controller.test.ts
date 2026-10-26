import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
import { G } from "../glyphs";
import { memorySink } from "../scrollback";
import { palette } from "../theme";
import { lineText } from "../width";
import { Controller } from "./controller";
import { MockBridge } from "./mock-bridge";

const INFO = {
  session_id: "s1",
  project: { root: "/home/alex/proj", branch: "main", dirty_total: 0, instruction_file: null, is_git: true },
  mode: "build",
  model: "gemma4:cloud",
  rules: [],
  context_length: 8192,
  checkpoints: { mode: "shadow", note: "" },
};
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const E = G.elbow;
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function make(over: Partial<{ width: number; config: Record<string, unknown> }> = {}) {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = over.config ?? { default_chat_model: "gemma4:cloud" };
  bridge.answers["code.start"] = INFO;
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  bridge.answers["models.installed"] = { models: [{ name: "gemma4:cloud" }, { name: "llama3.2:3b" }] };
  const sink = memorySink();
  let clock = 1000;
  const exits: string[] = [];
  const resumed: unknown[][] = [];
  const c = new Controller({
    bridge,
    sink,
    now: () => clock,
    width: () => over.width ?? 80,
    cwd: "/home/alex/proj",
    home: "/home/alex",
    onExit: () => exits.push("exit"),
    onResume: (m) => resumed.push(m),
  });
  return { bridge, sink, c, exits, resumed, tick: (ms: number) => (clock += ms) };
}

async function started(over: Parameters<typeof make>[0] = {}) {
  const m = make(over);
  await m.c.start(ARGS);
  return m;
}

/** A running turn, with the prompt already written. */
async function running(prompt = "fix it") {
  const m = await started();
  m.c.submit(prompt);
  await settle();
  return { ...m, turn: m.bridge.lastStream };
}

const PERM = (id: number, extra: Record<string, unknown> = {}) => ({
  name: "edit_file",
  arguments: { path: "calc.py" },
  diff: null,
  suggested_rule: { tool: "edit_file", pattern: null, scope: "session" },
  mode: "build",
  reason: "edit",
  permission_id: id,
  ...extra,
});

describe("start-up", () => {
  test("config.get, then code.start with the folder, model, mode and the opt-ins", async () => {
    const { bridge, c } = make();
    expect(c.getState().phase).toBe("starting");
    await c.start({ cont: false, mode: "plan", mcp: ["files"], kb: ["docs"] });
    expect(bridge.calls.map((x) => x.method)).toEqual(["config.get", "code.start"]);
    expect(bridge.to("code.start")[0]!.params).toEqual({
      cwd: "/home/alex/proj",
      model: "gemma4:cloud",
      mode: "plan",
      mcp: ["files"],
      knowledge: ["docs"],
    });
  });

  test("--model wins over the configured default; mode defaults to build", async () => {
    const { bridge, c } = make();
    await c.start({ ...ARGS, model: "llama3.2:3b" });
    expect(bridge.to("code.start")[0]!.params).toMatchObject({ model: "llama3.2:3b", mode: "build" });
  });

  test("the header and the notes are written; state is idle with the session's values", async () => {
    const { sink, c, bridge } = make();
    bridge.answers["code.start"] = {
      ...INFO,
      project: { ...INFO.project, instruction_file: "AGENTS.md" },
      checkpoints: { mode: "files", note: "no git here: undo keeps copies of the files" },
    };
    await c.start(ARGS);
    expect(sink.lines).toEqual([
      ` aihub-code 0.2.0 ${G.sep} gemma4:cloud ${G.sep} build ${G.sep} ~/proj (main)`,
      "AGENTS.md loaded",
      "no git here: undo keeps copies of the files",
    ]);
    expect(c.getState()).toMatchObject({
      phase: "idle",
      mode: "build",
      model: "gemma4:cloud",
      sessionId: "s1",
      ctx: { used: 0, limit: 8192 },
      activity: null,
      permission: null,
      queue: [],
      todos: [],
    });
  });

  test("a folder that is not a git repository is noted", async () => {
    const { sink, c, bridge } = make();
    bridge.answers["code.start"] = { ...INFO, project: { ...INFO.project, branch: null, is_git: false } };
    await c.start(ARGS);
    expect(sink.lines.slice(1)).toEqual(["not a git repository"]);
  });

  test("--continue resumes the newest session of the folder", async () => {
    const { bridge, c, resumed } = make();
    bridge.answers["code.sessions"] = { sessions: [{ id: "new", updated: "b" }, { id: "old", updated: "a" }] };
    bridge.answers["code.resume"] = { ...INFO, session_id: "new", model: "saved:7b", messages: [{ role: "user", content: "hi" }] };
    await c.start({ ...ARGS, cont: true });
    expect(bridge.calls.map((x) => [x.method, x.params])).toEqual([
      ["config.get", {}],
      ["code.sessions", { cwd: "/home/alex/proj" }],
      ["code.resume", { cwd: "/home/alex/proj", session_id: "new" }],
    ]);
    expect(c.getState()).toMatchObject({ phase: "idle", sessionId: "new", model: "saved:7b" });
    expect(resumed).toEqual([[{ role: "user", content: "hi" }]]);
  });

  test("the resumed conversation is handed over before a prompt typed meanwhile is written", async () => {
    const { bridge, sink } = make();
    bridge.answers["code.resume"] = { ...INFO, messages: [] };
    const order: string[] = [];
    const c2 = new Controller({
      bridge,
      sink,
      now: () => 0,
      width: () => 80,
      cwd: "/p",
      onResume: () => order.push(`replay after ${sink.lines.length} lines`),
    });
    const p = c2.start({ ...ARGS, resume: "s1" });
    c2.submit("typed early");
    await p;
    await settle();
    expect(order).toEqual(["replay after 1 lines"]);
    expect(sink.lines.at(-1)).toBe("> typed early");
  });

  test("--continue with no earlier session notes it and starts a new one", async () => {
    const { bridge, c, sink } = make();
    bridge.answers["code.sessions"] = { sessions: [] };
    await c.start({ ...ARGS, cont: true });
    expect(bridge.to("code.start")).toHaveLength(1);
    expect(sink.lines).toContain("no earlier session here: starting a new one");
  });

  test("--resume ID resumes that session", async () => {
    const { bridge, c } = make();
    bridge.answers["code.resume"] = { ...INFO, session_id: "abc", messages: [] };
    await c.start({ ...ARGS, resume: "abc" });
    expect(bridge.to("code.resume")[0]!.params).toEqual({ cwd: "/home/alex/proj", session_id: "abc" });
    expect(c.getState().sessionId).toBe("abc");
  });

  test("--resume alone opens a picker of the folder's sessions", async () => {
    const { bridge, c } = make();
    bridge.answers["code.sessions"] = {
      sessions: [{ id: "s2", updated: "2026-10-26T10:00:00", title: "fix calc", turns: 3 }],
    };
    bridge.answers["code.resume"] = { ...INFO, session_id: "s2", messages: [] };
    await c.start({ ...ARGS, resume: true });
    const st = c.getState();
    expect(st.phase).toBe("picker");
    expect(st.picker?.kind).toBe("session");
    expect(st.picker?.items.map((i) => i.id)).toEqual(["s2"]);
    expect(st.picker?.items[0]!.label).toContain("fix calc");
    await c.pick("s2");
    expect(c.getState()).toMatchObject({ phase: "idle", sessionId: "s2" });
  });

  test("no model anywhere opens the model picker; the choice starts the session", async () => {
    const { bridge, c } = make({ config: { default_chat_model: "" } });
    bridge.answers["models.installed"] = { models: [{ name: "llama3.2:3b" }, { name: "gemma4:cloud" }] };
    await c.start(ARGS);
    expect(c.getState().phase).toBe("picker");
    expect(c.getState().picker?.items.map((i) => i.id)).toEqual(["llama3.2:3b", "gemma4:cloud"]);
    expect(bridge.to("code.start")).toHaveLength(0);
    await c.pick("llama3.2:3b");
    expect(bridge.to("code.start")[0]!.params).toMatchObject({ model: "llama3.2:3b" });
    expect(c.getState().phase).toBe("idle");
  });

  test("a failed code.start is a red line; phase error, the bridge still alive", async () => {
    const { bridge, c, sink } = make();
    bridge.answers["code.start"] = new Error("no such folder: /nope");
    await c.start(ARGS);
    expect(c.getState()).toMatchObject({ phase: "error", error: "no such folder: /nope" });
    expect(sink.lines).toEqual([`${G.cross} no such folder: /nope`]);
    expect(sink.styled[0]![0]!.fg).toBe(palette.red);
  });

  test("a bridge that never became ready: phase error with its message", async () => {
    const { bridge, c, sink } = make();
    bridge.readyError = new Error("the bridge exited before it was ready (code 1) — see /x.log");
    await c.start(ARGS);
    expect(c.getState().phase).toBe("error");
    expect(sink.lines.join("\n")).toContain("exited before it was ready");
    expect(bridge.calls).toEqual([]);
  });

  test("prompts typed while starting wait, then go out", async () => {
    const { bridge, c } = make();
    const p = c.start(ARGS);
    c.submit("early bird");
    expect(c.getState().queue).toEqual(["early bird"]);
    await p;
    await settle();
    expect(bridge.to("code.turn")[0]!.params).toEqual({ text: "early bird" });
    expect(c.getState().queue).toEqual([]);
  });
});

describe("a turn", () => {
  test("submit writes the prompt, sends code.turn, and the activity says thinking", async () => {
    const { bridge, c, sink, tick } = await started();
    const before = sink.lines.length;
    tick(500);
    c.submit("fix the failing test");
    expect(sink.lines.slice(before)).toEqual(["", "> fix the failing test"]);
    expect(bridge.to("code.turn")[0]!.params).toEqual({ text: "fix the failing test" });
    expect(c.getState().phase).toBe("running");
    expect(c.getState().activity).toEqual({ label: "thinking…", since: 1500 });
  });

  test("blank submits are ignored", async () => {
    const { bridge, c } = await started();
    c.submit("   \n ");
    expect(bridge.to("code.turn")).toHaveLength(0);
    expect(c.getState().phase).toBe("idle");
  });

  test("events become transcript lines in order", async () => {
    const { turn, sink, c } = await running("go");
    const from = sink.lines.length;
    turn.emit("thinking", { text: "hmm" });
    turn.emit("text", { text: "Let me look.\n", round: 0 });
    turn.emit("tool_call", { call_id: "1", name: "read_file", arguments: { path: "calc.py" } });
    turn.emit("tool_result", { call_id: "1", name: "read_file", arguments: { path: "calc.py" }, result: "     1\tdef add(a, b):\n     2\t    return a - b\n" });
    turn.emit("tool_call", { call_id: "2", name: "edit_file", arguments: { path: "calc.py" } });
    turn.emit("code_diff", { path: "calc.py", text: "--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n", added: 1, removed: 1, created: false });
    turn.emit("tool_result", { call_id: "2", name: "edit_file", arguments: { path: "calc.py" }, result: "ok" });
    turn.emit("text", { text: "Fixed: add() subtracted.", round: 1 });
    turn.finish({ messages: [], cancelled: false });
    await settle();
    expect(sink.lines.slice(from)).toEqual([
      "Let me look.",
      `${G.bullet} read_file calc.py`,
      `  ${E} 2 lines`,
      `${G.bullet} edit_file calc.py`,
      `  ${E} -    return a - b`,
      "    +    return a + b",
      "Fixed: add() subtracted.",
    ]);
    expect(c.getState().phase).toBe("idle");
    expect(c.getState().activity).toBeNull();
  });

  test("streamed text is cut into lines at newlines; a partial line waits, and is flushed before a tool line", async () => {
    const { turn, sink } = await running();
    const from = sink.lines.length;
    turn.emit("text", { text: "Hel" });
    turn.emit("text", { text: "lo\nwor" });
    expect(sink.lines.slice(from)).toEqual(["Hello"]);
    turn.emit("tool_call", { name: "list_files", arguments: { directory: "." } });
    expect(sink.lines.slice(from)).toEqual(["Hello", "wor", `${G.bullet} list_files .`]);
  });

  test("the rest of the text is flushed when the turn ends", async () => {
    const { turn, sink, c } = await running();
    const from = sink.lines.length;
    turn.emit("text", { text: "no newline at the end" });
    expect(sink.lines.slice(from)).toEqual([]);
    turn.finish({});
    await settle();
    expect(sink.lines.slice(from)).toEqual(["no newline at the end"]);
    expect(c.getState().phase).toBe("idle");
  });

  test("tools: the activity names the running command, then goes back to thinking", async () => {
    const { turn, c, tick } = await running();
    tick(2000);
    turn.emit("tool_call", { name: "run_terminal", arguments: { command: "pytest -q" } });
    expect(c.getState().activity).toEqual({ label: "running pytest -q…", since: 3000 });
    tick(4000);
    turn.emit("tool_result", { name: "run_terminal", result: "3 passed\n[Exit: 0]" });
    expect(c.getState().activity).toEqual({ label: "thinking…", since: 7000 });
  });

  test("shell results show the output tail and the exit code", async () => {
    const { turn, sink } = await running();
    const from = sink.lines.length;
    turn.emit("tool_call", { name: "run_terminal", arguments: { command: "pytest -q" } });
    turn.emit("tool_result", { name: "run_terminal", arguments: { command: "pytest -q" }, result: `3 passed${"␍"}\n[Exit: 0]` });
    expect(sink.lines.slice(from)).toEqual([`${G.bullet} run_terminal pytest -q`, `  ${E} 3 passed  [exit 0]`]);
  });

  test("todos, context, compaction and a chat error", async () => {
    const { turn, sink, c } = await running();
    const from = sink.lines.length;
    turn.emit("code_context", { used: 1000, limit: 8192 });
    expect(c.getState().ctx).toEqual({ used: 1000, limit: 8192 });
    turn.emit("code_todos", { todos: [{ content: "fix add", status: "in_progress" }, { content: "run tests", status: "pending" }] });
    expect(c.getState().todos).toHaveLength(2);
    turn.emit("code_compaction", { method: "summary", before: 6400, after: 2048 });
    turn.emit("chat_error", { message: "model is gone", fatal: true });
    expect(sink.lines.slice(from)).toEqual([
      `  ${E} ${G.boxOpen} fix add`,
      `    ${G.boxOpen} run tests`,
      `${G.diamond} context compacted 78% ${G.arrow} 25% (summary)`,
      `${G.cross} model is gone`,
    ]);
  });

  test("the checkpoint fallback note is shown once", async () => {
    const { turn, sink } = await running();
    const from = sink.lines.length;
    turn.emit("code_checkpoint", { turn: "t1", mode: "files", note: "undo keeps copies of the files" });
    turn.emit("code_checkpoint", { turn: "t2", mode: "files", note: "undo keeps copies of the files" });
    turn.emit("code_checkpoint", { turn: "t3", mode: "shadow", note: "" });
    expect(sink.lines.slice(from)).toEqual(["undo keeps copies of the files"]);
  });

  test("unknown events are ignored", async () => {
    const { turn, sink } = await running();
    const from = sink.lines.length;
    turn.emit("usage", { prompt_tokens: 1 });
    turn.emit("round", { round: 0 });
    turn.emit("final", { text: "x" });
    turn.emit("something_new", {});
    expect(sink.lines.slice(from)).toEqual([]);
  });

  test("a turn that fails (engine error) prints it and returns to idle", async () => {
    const { turn, sink, c } = await running();
    turn.emit("text", { text: "partial" });
    turn.fail(new Error("Another aihub-code session is working in this project."));
    await settle();
    expect(sink.lines.slice(-2)).toEqual(["partial", `${G.cross} Another aihub-code session is working in this project.`]);
    expect(c.getState()).toMatchObject({ phase: "idle", activity: null });
  });
});

describe("the queue", () => {
  test("submit while running queues; after done the next prompt is sent", async () => {
    const { bridge, c, sink, turn } = await running("first");
    c.submit("second");
    c.submit("third");
    expect(bridge.to("code.turn")).toHaveLength(1);
    expect(c.getState().queue).toEqual(["second", "third"]);
    expect(sink.lines).not.toContain("> second");
    turn.finish({});
    await settle();
    expect(bridge.to("code.turn").map((x) => x.params.text)).toEqual(["first", "second"]);
    expect(c.getState()).toMatchObject({ phase: "running", queue: ["third"] });
    expect(sink.lines).toContain("> second");
    bridge.lastStream.finish({});
    await settle();
    expect(bridge.to("code.turn").map((x) => x.params.text)).toEqual(["first", "second", "third"]);
    bridge.lastStream.finish({});
    await settle();
    expect(c.getState()).toMatchObject({ phase: "idle", queue: [] });
  });

  test("only one code.turn is ever in flight", async () => {
    const { bridge, c } = await running("one");
    c.submit("two");
    await settle();
    expect(bridge.streams.filter((s) => s.method === "code.turn")).toHaveLength(1);
  });
});

describe("permission", () => {
  test("a request opens the prompt: phase, fields, and no activity", async () => {
    const { turn, c, sink } = await running();
    turn.emit("text", { text: "About to edit\n" });
    turn.emit("permission_request", PERM(1, { diff: { path: "calc.py", text: "-a\n+b\n", added: 1, removed: 1, created: false } }));
    const st = c.getState();
    expect(st.phase).toBe("permission");
    expect(st.activity).toBeNull();
    expect(st.permission).toMatchObject({
      requestId: turn.id,
      permissionId: 1,
      name: "edit_file",
      arguments: { path: "calc.py" },
      mode: "build",
      reason: "edit",
      suggestedRule: { tool: "edit_file", pattern: null, scope: "session" },
    });
    expect(st.permission!.diff?.path).toBe("calc.py");
    expect(sink.lines.at(-1)).toBe("About to edit"); // text before the prompt is in the scrollback
  });

  test("yes: allow true with the prompt's id; back to running", async () => {
    const { turn, c, bridge } = await running();
    turn.emit("permission_request", PERM(7));
    c.answer("yes", 7);
    expect(bridge.controls).toEqual([
      { method: "chat.permission", params: { request_id: turn.id, allow: true, permission_id: 7 } },
    ]);
    expect(c.getState()).toMatchObject({ phase: "running", permission: null });
    expect(c.getState().activity).not.toBeNull();
  });

  test("always: allow true and remember for the project", async () => {
    const { turn, c, bridge } = await running();
    turn.emit("permission_request", PERM(2));
    c.answer("always", 2);
    expect(bridge.controls[0]!.params).toEqual({ request_id: turn.id, allow: true, permission_id: 2, remember: "project" });
  });

  test("always without a suggested rule is just a yes", async () => {
    const { turn, c, bridge } = await running();
    turn.emit("permission_request", PERM(2, { suggested_rule: null }));
    c.answer("always", 2);
    expect(bridge.controls[0]!.params).toEqual({ request_id: turn.id, allow: true, permission_id: 2 });
  });

  test("no, with or without a message for the model", async () => {
    const { turn, c, bridge } = await running();
    turn.emit("permission_request", PERM(3));
    c.answer({ no: "use pytest -x instead" }, 3);
    turn.emit("permission_request", PERM(4));
    c.answer({ no: null }, 4);
    turn.emit("permission_request", PERM(5));
    c.answer({ no: "  " }, 5);
    expect(bridge.controls.map((x) => x.params)).toEqual([
      { request_id: turn.id, allow: false, permission_id: 3, message: "use pytest -x instead" },
      { request_id: turn.id, allow: false, permission_id: 4 },
      { request_id: turn.id, allow: false, permission_id: 5 },
    ]);
  });

  test("an answer with no prompt open sends nothing; a second answer is not sent twice", async () => {
    const { turn, c, bridge } = await running();
    c.answer("yes", 1);
    turn.emit("permission_request", PERM(1));
    c.answer("yes", 1);
    c.answer("yes", 1);
    expect(bridge.controls).toHaveLength(1);
  });

  test("a second request supersedes the first: the old id is never answered", async () => {
    const { turn, c, bridge } = await running();
    turn.emit("permission_request", PERM(1));
    turn.emit("permission_request", PERM(2, { name: "run_terminal", arguments: { command: "make" } }));
    expect(c.getState().permission).toMatchObject({ permissionId: 2, name: "run_terminal" });
    c.answer("yes", 1); // an answer meant for the old prompt
    expect(bridge.controls).toEqual([]);
    expect(c.getState().phase).toBe("permission");
    c.answer("yes", 2);
    expect(bridge.controls.map((x) => x.params!.permission_id)).toEqual([2]);
  });

  test("the prompt survives other events, which do not touch the phase", async () => {
    const { turn, c } = await running();
    turn.emit("permission_request", PERM(1));
    turn.emit("text", { text: "late words\n" });
    turn.emit("tool_result", { name: "read_file", result: "     1\tx\n" });
    expect(c.getState()).toMatchObject({ phase: "permission", activity: null });
    expect(c.getState().permission!.permissionId).toBe(1);
  });

  test("the turn finishing clears a prompt left open", async () => {
    const { turn, c } = await running();
    turn.emit("permission_request", PERM(1));
    turn.finish({});
    await settle();
    expect(c.getState()).toMatchObject({ phase: "idle", permission: null });
  });
});

describe("cancel", () => {
  test("sends chat.cancel, clears activity and prompt, prints ⎿ interrupted once", async () => {
    const { turn, c, bridge, sink } = await running();
    turn.emit("text", { text: "half a sent" });
    turn.emit("permission_request", PERM(1));
    c.cancel();
    c.cancel();
    expect(bridge.controls).toEqual([{ method: "chat.cancel", params: { request_id: turn.id } }]);
    expect(c.getState()).toMatchObject({ permission: null, activity: { label: "interrupting…" } });
    expect(sink.lines.slice(-2)).toEqual(["half a sent", `  ${E} interrupted`]);
    expect(sink.styled.at(-1)!.every((s) => s.dim)).toBe(true);
  });

  test("events after cancel are ignored; done ends the turn", async () => {
    const { turn, c, sink } = await running();
    c.cancel();
    const from = sink.lines.length;
    turn.emit("text", { text: "late\n" });
    turn.emit("tool_call", { name: "read_file", arguments: { path: "x" } });
    turn.emit("tool_result", { name: "read_file", result: "     1\tx\n" });
    turn.emit("code_diff", { path: "x", text: "-a\n+b", added: 1, removed: 1, created: false });
    turn.emit("code_todos", { todos: [{ content: "x", status: "pending" }] });
    turn.emit("chat_error", { message: "late error" });
    expect(sink.lines.slice(from)).toEqual([]);
    expect(c.getState().activity?.label).toBe("interrupting…"); // until the engine's done
    expect(c.getState().todos).toEqual([]);
    expect(c.getState().phase).toBe("running"); // the engine has not finished yet
    turn.finish({ cancelled: true });
    await settle();
    expect(c.getState()).toMatchObject({ phase: "idle", activity: null });
    expect(sink.lines.slice(from)).toEqual([]);
  });

  test("a second Esc while interrupting does nothing", async () => {
    const { turn, c, bridge, sink } = await running();
    c.cancel();
    const since = c.getState().activity;
    c.cancel();
    expect(bridge.controls).toHaveLength(1);
    expect(sink.lines.filter((l) => l.includes("interrupted"))).toHaveLength(1);
    expect(c.getState().activity).toBe(since);
    void turn;
  });

  test("a prompt that arrives after cancel is denied at once, not shown", async () => {
    const { turn, c, bridge } = await running();
    c.cancel();
    turn.emit("permission_request", PERM(9));
    expect(c.getState().permission).toBeNull();
    expect(bridge.controls.at(-1)).toEqual({
      method: "chat.permission",
      params: { request_id: turn.id, allow: false, permission_id: 9 },
    });
  });

  test("cancel with no turn does nothing; a queued prompt goes out after the cancelled turn's done", async () => {
    const m = await started();
    m.c.cancel();
    expect(m.bridge.controls).toEqual([]);
    expect(m.sink.lines.join("\n")).not.toContain("interrupted");
    m.c.submit("one");
    await settle();
    m.c.submit("two");
    m.c.cancel();
    m.bridge.lastStream.finish({ cancelled: true });
    await settle();
    expect(m.bridge.to("code.turn").map((x) => x.params.text)).toEqual(["one", "two"]);
  });
});

describe("the bridge dies", () => {
  test("mid-turn: phase error, the client's message in red, activity cleared, queue kept", async () => {
    const { turn, c, bridge, sink } = await running();
    c.submit("queued one");
    turn.emit("text", { text: "typing" });
    const gone = new Error("bridge process exited (code 1) — see /x.log");
    bridge.dead = gone;
    turn.fail(gone);
    await settle();
    expect(c.getState()).toMatchObject({
      phase: "error",
      error: gone.message,
      activity: null,
      permission: null,
      queue: ["queued one"],
    });
    expect(sink.lines.slice(-2)).toEqual(["typing", `${G.cross} bridge process exited (code 1) — see /x.log`]);
    expect(sink.styled.at(-1)![0]!.fg).toBe(palette.red);
  });

  test("while a prompt is open too", async () => {
    const { turn, c, bridge } = await running();
    turn.emit("permission_request", PERM(1));
    const gone = new Error("bridge process exited (code 9)");
    bridge.dead = gone;
    turn.fail(gone);
    await settle();
    expect(c.getState()).toMatchObject({ phase: "error", permission: null });
  });

  test("the input stays usable: submit says the bridge is gone, sends nothing, keeps the queue", async () => {
    const { turn, c, bridge, sink } = await running();
    c.submit("queued");
    const gone = new Error("bridge process exited (code 1)");
    bridge.dead = gone;
    turn.fail(gone);
    await settle();
    const calls = bridge.calls.length;
    const from = sink.lines.length;
    c.submit("anyone there?");
    expect(bridge.calls.length).toBe(calls);
    expect(sink.lines.slice(from).join(" ")).toContain("the bridge is gone");
    expect(sink.lines.slice(from).join(" ")).toContain("restart aihub-code");
    expect(c.getState().queue).toEqual(["queued"]);
    expect(c.getState().phase).toBe("error");
  });

  test("a bridge that died while idle is noticed at the next submit", async () => {
    const { c, bridge, sink } = await started();
    bridge.dead = new Error("bridge process exited (code 3)");
    c.submit("hello");
    expect(bridge.to("code.turn")).toHaveLength(0);
    expect(sink.lines.join(" ")).toContain("the bridge is gone");
    expect(c.getState().phase).toBe("error");
  });

  test("a session that never started: submit explains what to do", async () => {
    const { bridge, c, sink } = make();
    bridge.answers["code.start"] = new Error("no such folder");
    await c.start(ARGS);
    const from = sink.lines.length;
    c.submit("hello");
    expect(bridge.to("code.turn")).toHaveLength(0);
    expect(sink.lines.slice(from).join(" ")).toContain("no session");
  });
});

describe("mode", () => {
  test("setMode asks the engine and notes the change", async () => {
    const { c, bridge, sink } = await started();
    c.setMode("plan");
    expect(c.getState().mode).toBe("plan");
    await settle();
    expect(bridge.to("code.mode")[0]!.params).toEqual({ mode: "plan" });
    expect(sink.lines.at(-1)).toBe("mode: plan");
  });

  test("cycleMode: build → auto → plan → build", async () => {
    const { c } = await started();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      c.cycleMode();
      seen.push(c.getState().mode);
      await settle();
    }
    expect(seen).toEqual(["auto", "plan", "build", "auto"]);
  });

  test("quick presses are sent one at a time, ending on the last mode", async () => {
    const { c, bridge, sink } = await started();
    c.cycleMode();
    c.cycleMode();
    c.cycleMode();
    expect(c.getState().mode).toBe("build");
    await settle();
    expect(bridge.to("code.mode").map((x) => x.params.mode)).toEqual(["auto", "build"]);
    expect(sink.lines.filter((l) => l.startsWith("mode:"))).toEqual(["mode: build"]);
    expect(c.getState().mode).toBe("build");
  });

  test("a refused change goes back to the engine's mode with the reason", async () => {
    const { c, bridge, sink } = await started();
    bridge.answers["code.mode"] = new Error("unknown mode 'x'");
    c.setMode("plan");
    await settle();
    expect(c.getState().mode).toBe("build");
    expect(sink.lines.at(-1)).toBe(`${G.cross} unknown mode 'x'`);
  });

  test("not while a turn runs: a note, no request", async () => {
    const { c, bridge, sink } = await running();
    c.setMode("plan");
    await settle();
    expect(bridge.to("code.mode")).toHaveLength(0);
    expect(c.getState().mode).toBe("build");
    expect(sink.lines.at(-1)).toBe("mode can change when the turn is done");
  });

  test("not before a session exists", async () => {
    const { c, bridge } = make();
    c.cycleMode();
    expect(bridge.to("code.mode")).toHaveLength(0);
  });
});

describe("commands, exit, subscribe", () => {
  test("runCommand calls the table; an unknown one is a dim note", async () => {
    const bridge = new MockBridge();
    const sink = memorySink();
    const seen: unknown[] = [];
    const c = new Controller({
      bridge,
      sink,
      now: () => 0,
      width: () => 80,
      cwd: "/p",
      commands: { hello: (_c, arg) => void seen.push(arg) },
    });
    await c.runCommand("hello", "world");
    await c.runCommand("nope", "");
    expect(seen).toEqual(["world"]);
    expect(sink.lines).toEqual([`unknown command /nope ${"—"} /help lists them`]);
    expect(sink.styled[0]![0]!.dim).toBe(true);
  });

  test("exit cancels a running turn and calls onExit; the session is then resumable", async () => {
    const { c, exits, sink, bridge, turn } = await running();
    c.exit();
    expect(bridge.controls).toEqual([{ method: "chat.cancel", params: { request_id: turn.id } }]);
    // The app prints the resume line itself once the terminal is restored.
    expect(sink.lines.some((l) => l.startsWith("Resume"))).toBe(false);
    expect(c.resumableSessionId()).toBe("s1");
    expect(exits).toEqual(["exit"]);
    c.exit();
    expect(exits).toEqual(["exit"]);
  });

  test("a session nothing was said in is not offered for resume", async () => {
    const { c, exits } = await started();
    expect(c.resumableSessionId()).toBe("");
    c.exit();
    expect(exits).toEqual(["exit"]);
  });

  test("subscribers hear about changes, state objects are replaced, unsubscribe works", async () => {
    const { c } = make();
    let n = 0;
    const off = c.subscribe(() => n++);
    const first = c.getState();
    await c.start(ARGS);
    expect(n).toBeGreaterThan(0);
    expect(c.getState()).not.toBe(first);
    expect(first.phase).toBe("starting"); // an old snapshot is never mutated
    off();
    const seen = n;
    c.setMode("plan");
    expect(n).toBe(seen);
  });
});

describe("fix round 1", () => {
  test("I1: a queue kept after a failed turn is sent in order, ahead of a later prompt", async () => {
    const { bridge, c, turn } = await running("first");
    c.submit("run tests");
    turn.fail(new Error("Another aihub-code session is working in this project."));
    await settle();
    c.submit("hello");
    await settle();
    expect(bridge.to("code.turn").map((x) => x.params.text)).toEqual(["first", "run tests"]);
    expect(c.getState().queue).toEqual(["hello"]);
    bridge.lastStream.finish({});
    await settle();
    expect(bridge.to("code.turn").map((x) => x.params.text)).toEqual(["first", "run tests", "hello"]);
  });

  test("I1: a prompt submitted while an old queue exists goes behind it", async () => {
    const { bridge, c } = await started();
    c.submit("a"); // sends
    await settle();
    c.submit("b");
    bridge.lastStream.fail(new Error("boom"));
    bridge.lastStream.fail(new Error("again")); // ignored: already settled
    await settle();
    expect(bridge.to("code.turn").map((x) => x.params.text)).toEqual(["a", "b"]);
  });

  test("I2: a prompt typed while a mode change is in flight waits for it", async () => {
    const { bridge, c, sink } = await started();
    let release!: () => void;
    bridge.answers["code.mode"] = (p: Record<string, unknown>) =>
      new Promise((res) => (release = () => res({ mode: p.mode }))) as unknown;
    c.cycleMode();
    await settle();
    c.submit("go ahead");
    await settle();
    expect(bridge.to("code.turn")).toHaveLength(0);
    expect(c.getState().queue).toEqual(["go ahead"]);
    release();
    await settle();
    expect(bridge.to("code.turn").map((x) => x.params.text)).toEqual(["go ahead"]);
    expect(sink.lines.indexOf("mode: auto")).toBeLessThan(sink.lines.indexOf("> go ahead"));
    expect(c.getState().queue).toEqual([]);
  });

  test("I2: a refused mode change still lets the queue go", async () => {
    const { bridge, c } = await started();
    bridge.answers["code.mode"] = new Error("nope");
    c.cycleMode();
    c.submit("next");
    await settle();
    expect(bridge.to("code.turn").map((x) => x.params.text)).toEqual(["next"]);
  });

  test("I3: a model the server lacks opens the picker with a note; code.start is not called", async () => {
    const { bridge, c, sink } = make();
    await c.start({ ...ARGS, model: "ghost:7b" });
    expect(bridge.to("code.start")).toHaveLength(0);
    expect(c.getState().phase).toBe("picker");
    expect(c.getState().picker?.items.map((i) => i.id)).toEqual(["gemma4:cloud", "llama3.2:3b"]);
    expect(sink.lines).toContain("model ghost:7b isn't available on the server — pick one");
    expect(sink.styled.at(-1)![0]!.dim).toBe(true);
    await c.pick("llama3.2:3b");
    expect(bridge.to("code.start")[0]!.params).toMatchObject({ model: "llama3.2:3b" });
    expect(bridge.to("models.installed")).toHaveLength(2); // the pick itself is not looked up again
  });

  test("I3: cloud.models is never asked during start-up", async () => {
    const { bridge, c } = make();
    await c.start({ ...ARGS, model: "llama3.2:3b" });
    await make().c.start({ ...ARGS, model: "ghost:7b" });
    expect(bridge.to("cloud.models")).toHaveLength(0);
    expect(bridge.to("code.start")).toHaveLength(1);
  });

  test("I3: an empty installed list (the engine's answer for an offline server) does not open the picker", async () => {
    const { bridge, c } = make();
    bridge.answers["models.installed"] = { models: [] };
    await c.start({ ...ARGS, model: "llama3.2:3b" });
    expect(bridge.to("code.start")).toHaveLength(1);
    expect(c.getState().phase).toBe("idle");
  });

  test("I3: a cloud name that is not installed goes straight to code.start", async () => {
    for (const name of ["kimi-k3:cloud", "gpt-oss:120b-cloud"]) {
      const { bridge, c } = make();
      await c.start({ ...ARGS, model: name });
      expect(bridge.to("code.start"), name).toHaveLength(1);
      expect(c.getState().phase).toBe("idle");
    }
  });

  test("I3: a name without a tag matches its :latest", async () => {
    const { bridge, c } = make();
    bridge.answers["models.installed"] = { models: [{ name: "qwen2.5-coder:latest" }, { name: "llama3.2:3b" }] };
    await c.start({ ...ARGS, model: "qwen2.5-coder" });
    expect(bridge.to("code.start")).toHaveLength(1);
    const other = make();
    other.bridge.answers["models.installed"] = { models: [{ name: "qwen2.5-coder:7b" }] };
    await other.c.start({ ...ARGS, model: "qwen2.5-coder" });
    expect(other.c.getState().phase).toBe("picker"); // only :7b is installed, not :latest
  });

  test("I3: if the lookup fails (or has no list) code.start goes ahead", async () => {
    for (const answer of [new Error("Ollama is offline"), {}]) {
      const { bridge, c } = make();
      bridge.answers["models.installed"] = answer;
      await c.start({ ...ARGS, model: "ghost:7b" });
      expect(bridge.to("code.start")).toHaveLength(1);
      expect(c.getState().phase).toBe("idle");
    }
  });

  test("I3: the configured default is checked too", async () => {
    const { bridge, c } = make({ config: { default_chat_model: "qwen:0.5b" } });
    await c.start(ARGS);
    expect(c.getState().phase).toBe("picker");
    expect(bridge.to("code.start")).toHaveLength(0);
  });

  test("M1: a checkpoint note flushes the partial text first", async () => {
    const { turn, sink } = await running();
    const from = sink.lines.length;
    turn.emit("text", { text: "half" });
    turn.emit("code_checkpoint", { turn: "t", mode: "files", note: "copies only" });
    expect(sink.lines.slice(from)).toEqual(["half", "copies only"]);
  });

  test("M4: cycling back to the mode in flight still prints its note", async () => {
    const { bridge, c, sink } = await started();
    const releases: (() => void)[] = [];
    bridge.answers["code.mode"] = (p: Record<string, unknown>) =>
      new Promise((res) => releases.push(() => res({ mode: p.mode }))) as unknown;
    c.setMode("plan"); // in flight
    await settle();
    c.setMode("auto");
    c.setMode("plan"); // back to the one in flight
    expect(c.getState().mode).toBe("plan");
    releases[0]!();
    await settle();
    expect(bridge.to("code.mode").map((x) => x.params.mode)).toEqual(["plan"]);
    expect(sink.lines.filter((l) => l.startsWith("mode:"))).toEqual(["mode: plan"]);
    expect(c.getState().mode).toBe("plan");
    c.setMode("build"); // and the machine is still usable
    await settle();
    releases[1]!();
    await settle();
    expect(sink.lines.at(-1)).toBe("mode: build");
  });

  test("M5: while the picked session starts, the phase is starting and prompts queue", async () => {
    const { bridge, c } = make();
    bridge.answers["code.sessions"] = { sessions: [{ id: "s2", updated: "", title: "t", turns: 1 }] };
    let release!: () => void;
    bridge.answers["code.resume"] = () => new Promise((res) => (release = () => res({ ...INFO, session_id: "s2", messages: [] }))) as unknown;
    await c.start({ ...ARGS, resume: true });
    const picking = c.pick("s2");
    await settle();
    expect(c.getState()).toMatchObject({ phase: "starting", picker: null });
    c.submit("early");
    expect(c.getState().queue).toEqual(["early"]);
    release();
    await picking;
    await settle();
    expect(bridge.to("code.turn")[0]!.params).toEqual({ text: "early" });
  });

  test("M6: the bridge dying during start-up prints one red line", async () => {
    const { bridge, c, sink } = make();
    const gone = new Error("bridge process exited (code 1)");
    bridge.answers["code.start"] = () => {
      bridge.dead = gone;
      return gone;
    };
    await c.start(ARGS);
    expect(sink.lines.filter((l) => l.startsWith(G.cross))).toEqual([`${G.cross} bridge process exited (code 1)`]);
    expect(c.getState().phase).toBe("error");
  });
});

