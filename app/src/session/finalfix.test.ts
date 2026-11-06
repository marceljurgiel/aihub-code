/**
 * The 0.3.0 final fix wave's minors (m1–m3, m7, d3–d7): each a small rule
 * the final whole-branch review found missing.
 */
import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
import type { Attachment } from "../bridge/types";
import { commandTable } from "../commands";
import { memorySink } from "../scrollback";
import { Controller } from "./controller";
import { MockBridge } from "./mock-bridge";

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
  mcp: false,
  knowledge: [] as string[],
};
const BASES = [
  { name: "docs", description: "Project docs" },
  { name: "notes", description: "" },
];
const SYS = { role: "system", content: "s" };
const IMG: Attachment = { id: "img1", name: "a.png", kind: "image", bytes: 10 } as unknown as Attachment;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A request the test answers by hand: `release` resolves the latest one. */
function hold(bridge: MockBridge, method: string) {
  const h = { release: (_v: unknown) => {}, count: 0 };
  bridge.answers[method] = () => {
    h.count++;
    return new Promise((r) => (h.release = r));
  };
  return h;
}

async function started(args: Partial<Args> = {}) {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud" };
  let n = 0;
  bridge.answers["code.start"] = (p: Record<string, unknown>) => ({ ...INFO, session_id: `s${++n}`, model: p.model, knowledge: p.knowledge ?? [] });
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  bridge.answers["kb.list"] = { bases: BASES };
  bridge.answers["code.options"] = (p: Record<string, unknown>) => ({ mcp: p.mcp ?? false, knowledge: p.knowledge ?? [] });
  bridge.answers["chat.start"] = { messages: [SYS] };
  bridge.answers["chat.finalize"] = { path: "/tmp/x.json" };
  bridge.answers["mcp.list"] = { servers: [] };
  bridge.answers["models.installed"] = { models: [{ name: "gemma4:cloud" }, { name: "llama3.2:3b" }] };
  bridge.answers["hardware.recommend_context"] = { context: 4096 };
  bridge.answers["vision.check"] = { vision: true };
  bridge.answers["attach.paste"] = { attachments: [IMG] };
  bridge.answers["memory.learn"] = { changes: [], cursor: 0 };
  const sink = memorySink();
  const exits: number[] = [];
  const c = new Controller({
    bridge,
    sink,
    commands: commandTable(),
    now: () => 1000,
    width: () => 100,
    cwd: "/home/alex/proj",
    home: "/home/alex",
    onExit: () => exits.push(1),
    exitGraceMs: 100,
  });
  await c.start({ cont: false, mcp: [], kb: [], ...args });
  await c.refreshKb();
  await settle();
  const text = () => sink.lines.join("\n");
  const count = (s: string) => sink.lines.filter((l) => l.includes(s)).length;
  const run = async (line: string) => {
    c.submit(line);
    await settle();
  };
  return { bridge, sink, c, text, count, run, exits };
}

describe("m1: loading a conversation from history drops pending images", () => {
  test("images attached before the load are gone, and the next turn carries none", async () => {
    const m = await started();
    expect(await m.c.attachPaths("/tmp/a.png")).toBe(true);
    expect(m.c.getState().images).toHaveLength(1);
    await m.c.loadHistory([SYS, { role: "user", content: "old" }, { role: "assistant", content: "x" }], "2026-10-01T10:00:00");
    expect(m.c.getState().images).toEqual([]);
    await m.run("more");
    expect(m.bridge.lastStream.method).toBe("chat.turn");
    const last = (m.bridge.lastStream.params.messages as Record<string, unknown>[]).at(-1)!;
    expect(last.images).toBeUndefined();
  });
});

describe("m2: a new code session keeps the pending /kb notes", () => {
  test("a /kb change still waiting when a model is picked prints its note once the new session has it", async () => {
    const m = await started();
    await m.run("/model nope:1b"); // the picker, over a live session
    expect(m.c.getState().phase).toBe("picker");
    const opt = hold(m.bridge, "code.options");
    await m.run("/kb docs"); // on the wire
    await m.run("/kb notes"); // waits behind it
    await m.c.pick("llama3.2:3b");
    await settle();
    expect(m.bridge.to("code.start").at(-1)!.params.knowledge).toEqual(["notes"]);
    expect(m.count("¶ Using notes in this chat")).toBe(1);
    opt.release({ mcp: false, knowledge: ["docs"] });
    await settle();
  });
});

describe("m3: options and session switches", () => {
  test("a session switch waits while a /kb change is being applied", async () => {
    const m = await started();
    const opt = hold(m.bridge, "code.options");
    await m.run("/kb docs");
    await m.run("/clear");
    await m.run("/model llama3.2:3b");
    await m.run("/agent chat");
    expect(m.count("wait until the /kb or /mcp change is applied")).toBe(3);
    expect(m.bridge.to("code.start")).toHaveLength(1);
    expect(m.bridge.to("chat.start")).toHaveLength(0);
    opt.release({ mcp: false, knowledge: ["docs"] });
    await settle();
    await m.run("/clear");
    expect(m.bridge.to("code.start")).toHaveLength(2);
  });

  test("a late code.options answer never overwrites the options of a newer session", async () => {
    const m = await started();
    await m.run("/model nope:1b");
    const opt = hold(m.bridge, "code.options");
    await m.run("/kb docs"); // on the wire for session s1
    await m.c.pick("llama3.2:3b"); // session s2 starts meanwhile, without docs
    await settle();
    expect(m.c.getState().sessionId).toBe("s2");
    expect(m.c.getState().knowledge).toEqual([]);
    opt.release({ mcp: false, knowledge: ["docs"] });
    await settle();
    expect(m.c.getState().knowledge).toEqual([]);
    expect(m.count("¶ Using docs")).toBe(0);
  });
});

describe("m3: code.options names its session", () => {
  test("each change says which session it is for", async () => {
    const m = await started();
    await m.run("/kb docs");
    await settle();
    expect(m.bridge.to("code.options").at(-1)!.params).toEqual({ knowledge: ["docs"], session_id: "s1" });
  });

  test("the engine's no for a session already replaced is not an error to show", async () => {
    const m = await started();
    await m.run("/model nope:1b");
    const opt = hold(m.bridge, "code.options");
    await m.run("/kb docs"); // for s1
    await m.c.pick("llama3.2:3b"); // s2 comes first in the engine
    await settle();
    opt.release(Promise.reject(new Error("that code session is no longer open")));
    await settle();
    expect(m.text()).not.toContain("no longer open");
    expect(m.c.getState().knowledge).toEqual([]);
  });
});

describe("m7: a scheduled task never starts while a session or a kind switch is coming up", () => {
  test("isBusy() while the session starts", async () => {
    const bridge = new MockBridge();
    bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud" };
    const start = hold(bridge, "code.start");
    const c = new Controller({ bridge, sink: memorySink(), commands: commandTable(), width: () => 100, cwd: "/p" });
    const p = c.start({ cont: false, mcp: [], kb: [] });
    await settle();
    expect(c.getState().phase).toBe("starting");
    expect(c.isBusy()).toBe(true);
    start.release({ ...INFO });
    await p;
    expect(c.isBusy()).toBe(false);
  });

  test("isBusy() while a kind switch writes its header", async () => {
    const m = await started();
    const chat = hold(m.bridge, "chat.start");
    const p = m.c.setKind({ type: "chat" });
    await settle();
    expect(m.c.isBusy()).toBe(true);
    chat.release({ messages: [SYS] });
    await p;
    await settle();
    expect(m.c.isBusy()).toBe(false);
  });
});

describe("d3: copy", () => {
  test("/kb with no bases has no F6", async () => {
    const m = await started();
    m.bridge.answers["kb.list"] = { bases: [] };
    await m.c.refreshKb();
    await m.run("/kb");
    expect(m.text()).toContain("No knowledge bases yet — /knowledge makes one from your documents.");
    expect(m.text()).not.toContain("F6");
  });
});

describe("d4: /model <name> under chat checks the model first", () => {
  test("a model the server lacks opens the picker with the note; nothing is started", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    const before = m.bridge.to("chat.start").length;
    await m.run("/model nope:1b");
    expect(m.text()).toContain("model nope:1b isn't available on the server");
    expect(m.c.getState().phase).toBe("picker");
    expect(m.bridge.to("chat.start")).toHaveLength(before);
    await m.c.pick("llama3.2:3b");
    await settle();
    expect(m.bridge.to("chat.start").at(-1)!.params).toEqual({ model: "llama3.2:3b", messages: [] });
    expect(m.c.getState()).toMatchObject({ model: "llama3.2:3b", kind: { type: "chat" } });
  });

  test("a model the server has switches at once", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("/model llama3.2:3b");
    expect(m.c.getState()).toMatchObject({ model: "llama3.2:3b", kind: { type: "chat" }, phase: "idle" });
  });
});

describe("d5: leaving during a kind switch", () => {
  test("exit while agent.check is out: nothing is opened afterwards", async () => {
    const m = await started();
    const check = hold(m.bridge, "agent.check");
    const p = m.c.setKind({ type: "agent", name: "coder", submode: "build" });
    await settle();
    m.c.exit();
    const lines = m.sink.lines.length;
    check.release({ ok: true, agent: { name: "coder" } });
    await p;
    await settle();
    expect(m.bridge.to("chat.start")).toHaveLength(0);
    expect(m.sink.lines.length).toBe(lines);
  });

  test("exit while chat.start is out: no divider is written", async () => {
    const m = await started();
    const chat = hold(m.bridge, "chat.start");
    const p = m.c.setKind({ type: "chat" });
    await settle();
    m.c.exit();
    const lines = m.sink.lines.length;
    chat.release({ messages: [SYS] });
    await p;
    await settle();
    expect(m.sink.lines.length).toBe(lines);
    expect(m.bridge.to("hardware.recommend_context")).toHaveLength(0);
  });
});

describe("d6: closing the knowledge window prunes deleted bases", () => {
  test("under the code agent: code.options without the deleted base", async () => {
    const m = await started();
    await m.run("/kb docs");
    expect(m.c.getState().knowledge).toEqual(["docs"]);
    m.bridge.answers["kb.list"] = { bases: [BASES[1]] };
    await m.c.knowledgeClosed();
    await settle();
    expect(m.bridge.to("code.options").at(-1)!.params).toEqual({ knowledge: [], session_id: "s1" });
    expect(m.c.getState().knowledge).toEqual([]);
  });

  test("under chat: the next turn no longer asks for it", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("/kb docs, notes");
    m.bridge.answers["kb.list"] = { bases: [BASES[1]] };
    await m.c.knowledgeClosed();
    await settle();
    expect(m.c.getState().knowledge).toEqual(["notes"]);
    await m.run("hi");
    expect(m.bridge.lastStream.params.knowledge).toEqual(["notes"]);
  });

  test("a failed kb.list prunes nothing", async () => {
    const m = await started();
    await m.run("/kb docs");
    m.bridge.answers["kb.list"] = new Error("engine said no");
    await m.c.knowledgeClosed();
    await settle();
    expect(m.c.getState().knowledge).toEqual(["docs"]);
  });
});

describe("d7: an attach that resolves after the conversation changed is dropped", () => {
  test("/new while attach.paste is out", async () => {
    const m = await started();
    const paste = hold(m.bridge, "attach.paste");
    const p = m.c.attachPaths("/tmp/a.png");
    await settle();
    await m.run("/new");
    paste.release({ attachments: [IMG] });
    expect(await p).toBe(true);
    expect(m.c.getState().images).toEqual([]);
    await m.run("go");
    expect(m.bridge.lastStream.params).toEqual({ text: "go" });
  });

  test("a model change while vision.check is out: no stale verdict, no attach", async () => {
    const m = await started();
    const vision = hold(m.bridge, "vision.check");
    const p = m.c.attachClipboard();
    await settle();
    await m.run("/model llama3.2:3b");
    vision.release({ vision: false });
    await p;
    await settle();
    expect(m.text()).not.toContain("can't see images");
    expect(m.bridge.to("attach.clipboard")).toHaveLength(0);
    expect(m.c.getState().images).toEqual([]);
  });

  test("a typed image path that meets a change while vision.check is out says to attach it again", async () => {
    const m = await started();
    const vision = hold(m.bridge, "vision.check");
    const p = m.c.attachPaths("/tmp/a.png");
    await settle();
    await m.run("/new");
    vision.release({ vision: true });
    expect(await p).toBe(true); // spoken for: the path is not sent as a prompt
    expect(m.text()).toContain("attach it again");
    expect(m.bridge.to("attach.paste")).toHaveLength(0);
    expect(m.c.getState().images).toEqual([]);
  });

  test("a kind switch while attach.paste is out", async () => {
    const m = await started();
    const paste = hold(m.bridge, "attach.paste");
    const p = m.c.attachPaths("/tmp/a.png");
    await settle();
    await m.c.setKind({ type: "chat" });
    paste.release({ attachments: [IMG] });
    await p;
    expect(m.c.getState().images).toEqual([]);
  });
});
