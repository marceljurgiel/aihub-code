import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
import { commandTable } from "../commands";
import { G } from "../glyphs";
import { memorySink } from "../scrollback";
import { lineText } from "../width";
import { Controller } from "./controller";
import { fmtMemoryChange, Learner, turnUserMessage, type MemoryChange } from "./learn";
import { MockBridge } from "./mock-bridge";

// The preload sets AIHUB_LEARN_IDLE_MS to 80.
const IDLE = Number(process.env.AIHUB_LEARN_IDLE_MS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
/** Wait until `pred` holds (polling), or fail after `ms`. */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await sleep(10);
  }
}

const SYS = { role: "system", content: "You are AIhub." };
const user = (content: string) => ({ role: "user", content });
const RUST: MemoryChange = { id: 1, op: "add", topic: "Language", before: null, after: "Rust" };

describe("Learner", () => {
  const make = (answer: (p: Record<string, unknown>) => unknown = (p) => ({ changes: [], cursor: (p.messages as unknown[]).filter((m: any) => m.role === "user").length })) => {
    const bridge = new MockBridge();
    bridge.answers["memory.learn"] = answer;
    const got: MemoryChange[][] = [];
    const errors: string[] = [];
    const busy = { on: false };
    const l = new Learner(bridge, undefined, { isBusy: () => busy.on, onChanges: (c) => got.push(c), onError: (t) => errors.push(t) });
    return { bridge, l, got, errors, busy, learns: () => bridge.to("memory.learn") };
  };
  test("the idle time comes from AIHUB_LEARN_IDLE_MS (20 s without it)", () => {
    expect(IDLE).toBe(80);
  });

  test("schedule: one memory.learn after the idle time, with {messages, cursor, model, session}; the answer's cursor is kept", async () => {
    const m = make();
    m.l.schedule([SYS, user("I work in Rust")], "gemma4:cloud", "2026-10-26T10:00");
    await sleep(IDLE / 2);
    expect(m.learns()).toHaveLength(0);
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params).toEqual({ messages: [SYS, user("I work in Rust")], cursor: 0, model: "gemma4:cloud", session: "2026-10-26T10:00" });
    m.l.schedule([SYS, user("I work in Rust"), user("I use Neovim")], "gemma4:cloud", "2026-10-26T10:00");
    await until(() => m.learns().length === 2);
    expect(m.learns()[1]!.params.cursor).toBe(1);
  });

  test("a schedule restarts the wait: two quick replies, one learn", async () => {
    const m = make();
    m.l.schedule([user("a")], "m", "s");
    await sleep(IDLE / 2);
    m.l.schedule([user("a"), user("b")], "m", "s");
    await sleep(IDLE * 2);
    expect(m.learns()).toHaveLength(1);
    expect(m.learns()[0]!.params.messages).toEqual([user("a"), user("b")]);
  });

  test("while busy (a turn or a scheduled task runs) it waits, then learns once", async () => {
    const m = make();
    m.busy.on = true;
    m.l.schedule([user("a")], "m", "s");
    await sleep(IDLE * 3);
    expect(m.learns()).toHaveLength(0);
    m.busy.on = false;
    await until(() => m.learns().length === 1);
    await sleep(IDLE * 2);
    expect(m.learns()).toHaveLength(1);
  });

  test("changes reach onChanges; nothing to learn (no user message, no model) asks nothing", async () => {
    const m = make(() => ({ changes: [RUST], cursor: 1 }));
    m.l.schedule([SYS], "m", "s");
    m.l.now();
    m.l.schedule([user("x")], "", "s");
    m.l.now();
    await settle();
    expect(m.learns()).toHaveLength(0);
    m.l.schedule([user("I work in Rust")], "m", "s");
    m.l.now();
    await until(() => m.got.length === 1);
    expect(m.got[0]).toEqual([RUST]);
  });

  test("reset: what is left is learned at once, then the next conversation counts from nextCursor", async () => {
    const m = make();
    m.l.schedule([user("a"), user("b")], "m", "old");
    m.l.reset(3);
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params).toMatchObject({ session: "old", cursor: 0 });
    m.l.schedule([user("1"), user("2"), user("3"), user("4")], "m", "new");
    m.l.now();
    await until(() => m.learns().length === 2);
    expect(m.learns()[1]!.params).toMatchObject({ session: "new", cursor: 3 });
  });

  test("one request at a time: a second learn waits for the first", async () => {
    let release!: () => void;
    const bridge = new MockBridge();
    let open = 0;
    let most = 0;
    bridge.answers["memory.learn"] = () => {
      open++;
      most = Math.max(most, open);
      return new Promise((r) => (release = () => (open--, r({ changes: [], cursor: 1 }))));
    };
    const l = new Learner(bridge);
    l.schedule([user("a")], "m", "s1");
    l.reset();
    l.schedule([user("b")], "m", "s2");
    l.now();
    await settle();
    expect(bridge.to("memory.learn")).toHaveLength(1);
    release();
    await until(() => bridge.to("memory.learn").length === 2);
    release();
    await settle();
    expect(most).toBe(1);
  });

  test("a failure is said once, not at every reply", async () => {
    const m = make(() => new Error("llama3.2:3b: 404 model not found"));
    for (let i = 0; i < 2; i++) {
      m.l.schedule([user(`x${i}`)], "m", "s");
      m.l.now();
      await until(() => m.learns().length === i + 1);
      await settle();
    }
    expect(m.errors).toEqual(["Learning memory failed: llama3.2:3b: 404 model not found"]);
  });

  test("cancel: a pending learn never goes out", async () => {
    const m = make();
    m.l.schedule([user("a")], "m", "s");
    m.l.cancel();
    await sleep(IDLE * 2);
    expect(m.learns()).toHaveLength(0);
  });

  test("codeTurn: each code turn's own user message joins the conversation memory.learn reads", async () => {
    const m = make();
    const turn1 = [SYS, { role: "user", content: "I work in Rust", images: ["x.png"] }, { role: "assistant", content: "ok", tool_calls: [] }];
    m.l.codeTurn({ messages: turn1 }.messages, "m", "s1", true);
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params.messages).toEqual([user("I work in Rust")]);
    // After /undo or /compact the session's messages shrink; what was learned stays learned.
    const turn2 = [SYS, { role: "user", content: "[Conversation summary] ..." }, user("I use Neovim"), { role: "tool", content: "r" }];
    m.l.codeTurn(turn2, "m", "s1", true);
    await until(() => m.learns().length === 2);
    expect(m.learns()[1]!.params).toMatchObject({ messages: [user("I work in Rust"), user("I use Neovim")], cursor: 1 });
    expect(m.l.codeMessages()).toEqual([user("I work in Rust"), user("I use Neovim")]);
  });
});

describe("turnUserMessage (the code session's messages, as memory.learn reads them)", () => {
  test("the last user message of the turn, role and content only", () => {
    expect(turnUserMessage([SYS, { role: "user", content: "fix it", images: ["a"] }, { role: "assistant", content: "done" }])).toEqual({ role: "user", content: "fix it" });
  });
  test("not a compaction summary, not the undo note, not a tool result; nothing when there is none", () => {
    expect(turnUserMessage([{ role: "user", content: "[Conversation summary] x" }])).toBeNull();
    expect(turnUserMessage([{ role: "user", content: "[The user undid the file changes of that turn.]" }])).toBeNull();
    expect(turnUserMessage([{ role: "tool", content: "x" }, { role: "user", content: 3 }])).toBeNull();
    expect(turnUserMessage(undefined)).toBeNull();
    expect(turnUserMessage([user("a"), { role: "user", content: "[The user undid the file changes of that turn.]" }])).toEqual(user("a"));
  });
});

describe("fmtMemoryChange (AIhub's memory line)", () => {
  const one = (c: MemoryChange) => fmtMemoryChange(c, 200).map(lineText).join("\n");
  const M = G.memory;
  test("added, updated, forgotten, undone", () => {
    expect(one(RUST)).toBe(`${M} Remembered · Language — Rust   /memory undo`);
    expect(one({ op: "update", topic: "Editor", before: "Neovim", after: "VS Code" })).toBe(`${M} Remembered · Editor — VS Code  (was: Neovim)   /memory undo`);
    expect(one({ op: "forget", topic: "Editor", before: "VS Code", after: null })).toBe(`${M} Forgot · Editor  (was: VS Code)   /memory undo`);
    expect(one({ op: "undo", topic: "Editor", before: "Neovim", after: "VS Code" })).toBe(`${M} Undid · Editor — VS Code`);
    expect(one({ op: "undo", topic: "Editor", before: null, after: null })).toBe(`${M} Undid · Editor — (removed)`);
  });
});

// ── in the controller ─────────────────────────────────────────────────────────

const INFO = {
  session_id: "s1",
  project: { root: "/home/alex/proj", branch: "main", dirty_total: 0, instruction_file: null, is_git: true },
  mode: "build",
  model: "gemma4:cloud",
  rules: [],
  context_length: 8192,
  backend: "ollama",
  stream_model: "gemma4:cloud",
  temperature: 0.7,
  checkpoints: { mode: "shadow", note: "" },
};
const ARGS: Args = { cont: false, mcp: [], kb: [] };

async function started() {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud" };
  bridge.answers["code.start"] = (p: Record<string, unknown>) => ({ ...INFO, session_id: `s${bridge.to("code.start").length}` });
  bridge.answers["chat.start"] = { messages: [SYS] };
  bridge.answers["chat.finalize"] = { path: "/tmp/x.json" };
  bridge.answers["hardware.recommend_context"] = { context: 4096 };
  bridge.answers["memory.learn"] = { changes: [], cursor: 1 };
  const sink = memorySink();
  const c = new Controller({ bridge, sink, commands: commandTable(), now: () => 1000, width: () => 100, cwd: "/home/alex/proj", home: "/home/alex" });
  await c.start(ARGS);
  const text = () => sink.lines.join("\n");
  const run = async (line: string) => {
    c.submit(line);
    await settle();
  };
  const learns = () => bridge.to("memory.learn");
  return { bridge, sink, c, text, run, learns };
}

const codeDone = (text: string, reply = "ok") => ({ messages: [SYS, { role: "user", content: text }, { role: "assistant", content: reply }], cancelled: false });

describe("learning after turns", () => {
  test("after a code turn: memory.learn once, after the idle time, with the turn's user message; a change is written as AIhub's note", async () => {
    const m = await started();
    m.bridge.answers["memory.learn"] = { changes: [RUST], cursor: 1 };
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await settle();
    expect(m.learns()).toHaveLength(0);
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params).toEqual({ messages: [{ role: "user", content: "I work in Rust" }], cursor: 0, model: "gemma4:cloud", session: "s1" });
    await until(() => m.text().includes("Remembered · Language — Rust"));
    expect(m.text()).toContain(`${G.memory} Remembered · Language — Rust   /memory undo`);
    await sleep(IDLE * 2);
    expect(m.learns()).toHaveLength(1);
  });

  test("after a chat turn: the conversation's messages, its start time as the session", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("I work in Rust");
    const s = m.bridge.lastStream;
    expect(s.method).toBe("chat.turn");
    const messages = [SYS, { role: "user", content: "I work in Rust" }, { role: "assistant", content: "Nice." }];
    s.finish({ messages });
    await until(() => m.learns().length === 1);
    const p = m.learns()[0]!.params;
    expect(p.messages).toEqual(messages);
    expect(p.cursor).toBe(0);
    expect(p.model).toBe("gemma4:cloud");
    expect(typeof p.session).toBe("string");
    expect(String(p.session)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test("a turn starting before the timer fires postpones it: nothing goes out while it runs, one learn after it", async () => {
    const m = await started();
    await m.run("first");
    m.bridge.lastStream.finish(codeDone("first"));
    await settle();
    await m.run("second");
    const second = m.bridge.lastStream;
    expect(second.params.text).toBe("second");
    await sleep(IDLE * 3);
    expect(m.learns()).toHaveLength(0);
    second.finish(codeDone("second"));
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params.messages).toEqual([{ role: "user", content: "first" }, { role: "user", content: "second" }]);
    await sleep(IDLE * 2);
    expect(m.learns()).toHaveLength(1);
  });

  test("a scheduled task running holds learning too", async () => {
    const m = await started();
    await m.run("I work in Rust");
    m.c.taskStarted("daily"); // (the clock never starts one next to a turn; the learner only looks at it)
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await sleep(IDLE * 3);
    expect(m.learns()).toHaveLength(0);
    m.c.taskEnded();
    m.c.taskIdle();
    await until(() => m.learns().length === 1);
  });

  test("an interrupted turn is not learned on its own, but the conversation's end learns it", async () => {
    const m = await started();
    await m.run("I work in Rust");
    m.c.cancel();
    m.bridge.lastStream.finish({ ...codeDone("I work in Rust", ""), cancelled: true });
    await sleep(IDLE * 2);
    expect(m.learns()).toHaveLength(0);
    await m.c.clear();
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params).toMatchObject({ messages: [{ role: "user", content: "I work in Rust" }], session: "s1" });
  });

  test("/clear learns what is left at once; the new session starts counting afresh", async () => {
    const m = await started();
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await settle();
    await m.c.clear();
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params.session).toBe("s1");
    await m.run("I use Neovim");
    m.bridge.lastStream.finish(codeDone("I use Neovim"));
    await until(() => m.learns().length === 2);
    expect(m.learns()[1]!.params).toMatchObject({ messages: [{ role: "user", content: "I use Neovim" }], cursor: 0, session: "s2" });
  });

  test("code → chat ends the code conversation (learned at once)", async () => {
    const m = await started();
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await settle();
    await m.c.setKind({ type: "chat" });
    await until(() => m.learns().length === 1);
    expect(m.learns()[0]!.params.session).toBe("s1");
  });

  test("exit drops a pending learn", async () => {
    const m = await started();
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await settle();
    m.c.exit();
    await sleep(IDLE * 2);
    expect(m.learns()).toHaveLength(0);
  });

  test("a failed learn is one red line", async () => {
    const m = await started();
    m.bridge.answers["memory.learn"] = new Error("llama3.2:3b: 404 model not found");
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await until(() => m.text().includes("Learning memory failed"));
    expect(m.text()).toContain(`${G.cross} Learning memory failed: llama3.2:3b: 404 model not found`);
  });
});

describe("a turn that ends without an answer", () => {
  const NOTE = "The model ended without an answer — ask it to continue, or try a bigger model.";
  test("chat: the last message isn't a non-empty reply → AIhub's red note", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("check the file");
    m.bridge.lastStream.finish({ messages: [SYS, { role: "user", content: "check the file" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "x" }] });
    await settle();
    expect(m.text()).toContain(`${G.cross} ${NOTE}`);
  });
  test("code: the same; a turn with a reply, an interrupted one or one without messages has none", async () => {
    const m = await started();
    await m.run("a");
    m.bridge.lastStream.finish(codeDone("a", "  "));
    await settle();
    expect(m.text()).toContain(NOTE);
    const before = m.sink.lines.length;
    await m.run("b");
    m.bridge.lastStream.finish(codeDone("b", "fine"));
    await m.run("c");
    m.c.cancel();
    m.bridge.lastStream.finish({ ...codeDone("c", ""), cancelled: true });
    await m.run("d");
    m.bridge.lastStream.finish({});
    await settle();
    expect(m.sink.lines.slice(before).join("\n")).not.toContain(NOTE);
  });
});

describe("a turn that ends on a fatal error", () => {
  const NOTE = "The model ended without an answer";
  test("code: the engine's error is shown, and no empty-answer note after it", async () => {
    const m = await started();
    await m.run("go");
    const turn = m.bridge.lastStream;
    turn.emit("chat_error", { message: "API error: model not found", fatal: true });
    turn.finish({ messages: [SYS, { role: "user", content: "go" }], cancelled: false });
    await settle();
    expect(m.text()).toContain(`${G.cross} API error: model not found`);
    expect(m.text()).not.toContain(NOTE);
  });
  test("chat: the same", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("go");
    const turn = m.bridge.lastStream;
    turn.emit("chat_error", { message: "Unexpected error: boom", fatal: true });
    turn.finish({ messages: [SYS, { role: "user", content: "go" }] });
    await settle();
    expect(m.text()).toContain("Unexpected error: boom");
    expect(m.text()).not.toContain(NOTE);
  });
  test("a non-fatal error doesn't hide a genuinely empty final reply after tool calls", async () => {
    const m = await started();
    await m.run("go");
    const turn = m.bridge.lastStream;
    turn.emit("chat_error", { message: "retrying without tools", fatal: false });
    turn.finish({ messages: [SYS, { role: "user", content: "go" }, { role: "assistant", content: "", tool_calls: [{}] }, { role: "tool", content: "x" }, { role: "assistant", content: "" }] });
    await settle();
    expect(m.text()).toContain(NOTE);
  });
  test("the next turn after a failed one gets the note again when it is empty", async () => {
    const m = await started();
    await m.run("a");
    m.bridge.lastStream.emit("chat_error", { message: "boom", fatal: true });
    m.bridge.lastStream.finish({ messages: [SYS, { role: "user", content: "a" }] });
    await m.run("b");
    m.bridge.lastStream.finish({ messages: [SYS, { role: "user", content: "b" }, { role: "assistant", content: "" }] });
    await settle();
    expect(m.text()).toContain(NOTE);
  });
});

describe("memory commands", () => {
  test("/memory undo → memory.undo {} and AIhub's line per reverted change", async () => {
    const m = await started();
    m.bridge.answers["memory.undo"] = { reverted: [RUST] };
    await m.run("/memory undo");
    expect(m.bridge.to("memory.undo")[0]!.params).toEqual({});
    expect(m.text()).toContain(`${G.memory} Undid · Language — Rust`);
    m.bridge.answers["memory.undo"] = { reverted: [] };
    await m.run("/memory undo");
    expect(m.text()).toContain("Nothing to undo — memory hasn't learned anything since the last undo.");
  });

  test("/memoryadd → memory.extract with the model and the conversation", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("I work in Rust");
    const messages = [SYS, { role: "user", content: "I work in Rust" }, { role: "assistant", content: "Nice." }];
    m.bridge.lastStream.finish({ messages });
    await settle();
    m.bridge.answers["memory.extract"] = { ok: true, summary: "- Language: Rust" };
    await m.run("/memoryadd");
    expect(m.bridge.to("memory.extract")[0]!.params).toEqual({ model: "gemma4:cloud", messages });
    expect(m.text()).toContain("Extracting facts from this chat…");
    expect(m.text()).toContain("Memory updated with extracted facts.");
    m.bridge.answers["memory.extract"] = { ok: false, summary: "Error: memory is turned off in Settings." };
    await m.run("/memoryadd");
    expect(m.text()).toContain(`${G.cross} Error: memory is turned off in Settings.`);
  });

  test("/memoryadd under the code agent sends the code conversation's user messages", async () => {
    const m = await started();
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await settle();
    await m.run("/memoryadd");
    expect(m.bridge.to("memory.extract")[0]!.params).toEqual({ model: "gemma4:cloud", messages: [{ role: "user", content: "I work in Rust" }] });
  });

  test("/memoryadd while a turn runs waits for it (one model request at a time)", async () => {
    const m = await started();
    await m.run("go");
    await m.run("/memoryadd");
    expect(m.bridge.to("memory.extract")).toHaveLength(0);
    expect(m.text()).toContain("Finish or interrupt the current turn first (Esc).");
  });

  test("/memoryadd with no user message yet says so and sends nothing", async () => {
    const m = await started();
    await m.run("/memoryadd");
    await m.c.setKind({ type: "chat" });
    await m.run("/memoryadd");
    expect(m.bridge.to("memory.extract")).toHaveLength(0);
    expect(m.sink.lines.filter((l) => l.includes("Nothing to learn from yet."))).toHaveLength(2);
    expect(m.text()).not.toContain("Extracting facts");
  });

  test("/memory clear, /memory save, wrong forms", async () => {
    const m = await started();
    await m.run("/memory clear");
    expect(m.bridge.to("memory.clear")).toHaveLength(1);
    expect(m.text()).toContain("Memory cleared.");
    await m.run("/memory save editor VS Code");
    expect(m.bridge.to("memory.save_entry")[0]!.params).toEqual({ key: "editor", value: "VS Code" });
    expect(m.text()).toContain("Saved “editor” to memory.");
    await m.run("/memory save editor");
    expect(m.text()).toContain("Usage: /memory save <key> <value>");
    await m.run("/memory forget");
    expect(m.text()).toContain("Unknown /memory subcommand.");
    expect(m.text()).not.toContain("coming in this release");
  });

  test("a failing memory call says what failed", async () => {
    const m = await started();
    m.bridge.answers["memory.undo"] = new Error("disk full");
    await m.run("/memory undo");
    expect(m.text()).toContain("Undoing memory failed: disk full");
  });
});

describe("one model request at a time across memory features (I1)", () => {
  const WAITING = "Waiting for memory… your message goes right after.";
  const BUSY = "Memory is using the model — try again when it is done.";
  /** A started session with one finished code turn, and memory.extract held back. */
  async function withHeldExtract() {
    const m = await started();
    let release!: (v: unknown) => void;
    m.bridge.answers["memory.extract"] = () => new Promise((r) => (release = r));
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await settle();
    return { ...m, release: (v: unknown) => release(v) };
  }

  test("a prompt typed during /memoryadd's extract waits (one note), then goes out after it", async () => {
    const m = await withHeldExtract();
    await m.run("/memoryadd");
    expect(m.bridge.to("memory.extract")).toHaveLength(1);
    await m.run("next one");
    await m.run("and another");
    expect(m.bridge.to("code.turn")).toHaveLength(1);
    expect(m.sink.lines.filter((l) => l.includes(WAITING))).toHaveLength(1);
    m.release({ ok: true });
    await settle();
    expect(m.bridge.to("code.turn")).toHaveLength(2);
    expect(m.bridge.lastStream.params.text).toBe("next one");
  });

  test("/compact during a learn is refused", async () => {
    const m = await started();
    let release!: (v: unknown) => void;
    m.bridge.answers["memory.learn"] = () => new Promise((r) => (release = r));
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await until(() => m.learns().length === 1);
    await m.run("/compact");
    expect(m.bridge.to("code.compact")).toHaveLength(0);
    expect(m.text()).toContain(BUSY);
    release({ changes: [], cursor: 1 });
    await settle();
  });

  test("/skill during a learn is refused", async () => {
    const m = await started();
    let release!: (v: unknown) => void;
    m.bridge.answers["memory.learn"] = () => new Promise((r) => (release = r));
    await m.run("I work in Rust");
    m.bridge.lastStream.finish(codeDone("I work in Rust"));
    await until(() => m.learns().length === 1);
    await m.run("/skill commit");
    expect(m.bridge.to("skills.invoke")).toHaveLength(0);
    expect(m.text()).toContain(BUSY);
    release({ changes: [], cursor: 1 });
    await settle();
  });

  test("a second /memoryadd during an extract is refused", async () => {
    const m = await withHeldExtract();
    await m.run("/memoryadd");
    await m.run("/memoryadd");
    expect(m.bridge.to("memory.extract")).toHaveLength(1);
    expect(m.text()).toContain(BUSY);
    m.release({ ok: true });
    await settle();
  });

  test("a learn does not start while an extract runs; it goes after", async () => {
    const m = await withHeldExtract();
    await m.run("/memoryadd");
    await sleep(IDLE * 3);
    expect(m.learns()).toHaveLength(0);
    m.release({ ok: true });
    await until(() => m.learns().length === 1);
  });

  test("isBusy() is the same gate: true during an extract and a learn", async () => {
    const m = await withHeldExtract();
    expect(m.c.isBusy()).toBe(false);
    await m.run("/memoryadd");
    expect(m.c.isBusy()).toBe(true);
    m.release({ ok: true });
    await settle();
    expect(m.c.isBusy()).toBe(false);
  });
});
