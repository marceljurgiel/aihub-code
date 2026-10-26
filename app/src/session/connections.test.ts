import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
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
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function started(args: Partial<Args> = {}, info: Record<string, unknown> = {}, onExit?: () => void, exitGraceMs?: number) {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud" };
  bridge.answers["code.start"] = (p: Record<string, unknown>) => ({ ...INFO, ...info, model: p.model });
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  bridge.answers["kb.list"] = { bases: BASES };
  bridge.answers["code.options"] = (p: Record<string, unknown>) => ({ mcp: p.mcp ?? false, knowledge: p.knowledge ?? [] });
  bridge.answers["chat.start"] = { messages: [{ role: "system", content: "s" }] };
  bridge.answers["mcp.list"] = { servers: [] };
  const sink = memorySink();
  const c = new Controller({ bridge, sink, commands: commandTable(), now: () => 1000, width: () => 100, cwd: "/home/alex/proj", home: "/home/alex", onExit, exitGraceMs });
  await c.start({ cont: false, mcp: [], kb: [], ...args });
  await c.refreshKb();
  await settle();
  const text = () => sink.lines.join("\n");
  const run = async (line: string) => {
    c.submit(line);
    await settle();
  };
  return { bridge, sink, c, text, run };
}

describe("/kb under the code agent", () => {
  test("/kb docs → code.options and the note", async () => {
    const m = await started();
    await m.run("/kb docs");
    expect(m.bridge.to("code.options")).toEqual([{ method: "code.options", params: { knowledge: ["docs"] } }]);
    expect(m.text()).toContain("¶ Using docs in this chat — answers draw on those documents and cite them [1]. /kb off stops.");
    expect(m.c.getState().knowledge).toEqual(["docs"]);
  });

  test("a second base is added to the first", async () => {
    const m = await started();
    await m.run("/kb docs");
    await m.run("/kb notes, docs");
    expect(m.bridge.to("code.options").at(-1)!.params).toEqual({ knowledge: ["docs", "notes"] });
    expect(m.text()).toContain("¶ Using docs, notes in this chat");
  });

  test("/kb nope is an error and changes nothing", async () => {
    const m = await started();
    await m.run("/kb nope");
    expect(m.text()).toContain("No knowledge base called nope — /kb lists them.");
    expect(m.bridge.to("code.options")).toHaveLength(0);
    expect(m.c.getState().knowledge).toEqual([]);
  });

  test("/kb off", async () => {
    const m = await started();
    await m.run("/kb docs");
    await m.run("/kb off");
    expect(m.bridge.to("code.options").at(-1)!.params).toEqual({ knowledge: [] });
    expect(m.text()).toContain("Knowledge off for this chat.");
    expect(m.c.getState().knowledge).toEqual([]);
  });

  test("/kb lists the bases, marking the active ones", async () => {
    const m = await started();
    await m.run("/kb");
    expect(m.text()).toContain("Knowledge bases: docs (Project docs) · notes");
    expect(m.text()).toContain("Use one here: /kb <name>.");
    await m.run("/kb docs");
    await m.run("/kb");
    expect(m.text()).toContain("✓ docs (Project docs) · notes");
    expect(m.text()).toContain("Active here: docs — /kb off to stop.");
  });

  test("with no bases, /kb says how to make one", async () => {
    const m = await started();
    m.bridge.answers["kb.list"] = { bases: [] };
    await m.c.refreshKb();
    await m.run("/kb");
    expect(m.text()).toContain("No knowledge bases yet — /knowledge (F6) makes one from your documents.");
  });

  test("during a turn the change waits, and goes out with its note when the turn ends", async () => {
    const m = await started();
    m.c.submit("fix it");
    await settle();
    await m.run("/kb docs");
    expect(m.bridge.to("code.options")).toHaveLength(0);
    expect(m.text()).not.toContain("¶ Using docs");
    m.bridge.lastStream.finish({});
    await settle();
    expect(m.bridge.to("code.options")).toEqual([{ method: "code.options", params: { knowledge: ["docs"] } }]);
    expect(m.text()).toContain("¶ Using docs in this chat");
    expect(m.c.getState().knowledge).toEqual(["docs"]);
  });

  test("a prompt queued behind a waiting /kb change still goes out, after code.options", async () => {
    const m = await started();
    m.c.submit("fix it");
    await settle();
    await m.run("/kb docs");
    await m.run("then this");
    expect(m.c.getState().queue).toEqual(["then this"]);
    m.bridge.lastStream.finish({});
    await settle();
    const order = m.bridge.calls.map((x) => x.method).filter((x) => x === "code.options" || x === "code.turn");
    expect(order).toEqual(["code.turn", "code.options", "code.turn"]);
    expect(m.bridge.lastStream.params).toEqual({ text: "then this" });
    expect(m.c.getState().queue).toEqual([]);
  });

  test("an interrupt drops the queue but the /kb change still goes out", async () => {
    const m = await started();
    m.c.submit("fix it");
    await settle();
    await m.run("/kb docs");
    await m.run("queued");
    m.c.cancel();
    expect(m.text()).toContain("dropped 1 queued prompt");
    m.bridge.lastStream.finish({});
    await settle();
    expect(m.bridge.to("code.options")).toEqual([{ method: "code.options", params: { knowledge: ["docs"] } }]);
    expect(m.bridge.to("code.turn")).toHaveLength(1);
    expect(m.c.getState().knowledge).toEqual(["docs"]);
  });

  test("/exit during a turn applies a waiting /kb change before leaving", async () => {
    const exits: string[] = [];
    const m = await started({}, {}, () => exits.push("exit"));
    m.c.submit("fix it");
    await settle();
    await m.run("/kb docs");
    await m.run("/exit");
    await settle();
    m.bridge.lastStream.finish({});
    await settle();
    expect(m.bridge.to("code.options")).toEqual([{ method: "code.options", params: { knowledge: ["docs"] } }]);
    expect(exits).toEqual(["exit"]);
    const order = m.bridge.calls.map((x) => x.method);
    expect(order.lastIndexOf("code.options")).toBeGreaterThan(order.lastIndexOf("code.turn"));
  });

  test("/exit when the turn never ends says the change was not applied", async () => {
    const exits: string[] = [];
    const m = await started({}, {}, () => exits.push("exit"), 20);
    m.c.submit("fix it");
    await settle();
    await m.run("/kb docs");
    await m.run("/exit");
    await new Promise((r) => setTimeout(r, 60));
    expect(m.bridge.to("code.options")).toHaveLength(0);
    expect(m.text()).toContain("The /kb and /mcp change was not applied");
    expect(exits).toEqual(["exit"]);
  });

  test("a refused change is an error line, not silence", async () => {
    const m = await started();
    m.bridge.answers["code.options"] = new Error("a turn is running");
    await m.run("/kb docs");
    expect(m.text()).toContain("a turn is running");
    expect(m.c.getState().knowledge).toEqual([]);
  });

  test("the bases of the start flags and a resumed session show at once", async () => {
    const m = await started({ kb: ["docs"] }, { knowledge: ["docs"], mcp: true });
    expect(m.c.getState().knowledge).toEqual(["docs"]);
    expect(m.c.getState().mcp).toBe(true);
  });
});

describe("/kb under chat and agents", () => {
  test("the next chat.turn carries the base; no code.options", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("/kb docs");
    expect(m.bridge.to("code.options")).toHaveLength(0);
    expect(m.c.getState().knowledge).toEqual(["docs"]);
    expect(m.text()).toContain("¶ Using docs in this chat");
    await m.run("hi");
    expect(m.bridge.lastStream.method).toBe("chat.turn");
    expect(m.bridge.lastStream.params.knowledge).toEqual(["docs"]);
    m.bridge.lastStream.finish({ messages: [] });
    await settle();
    await m.run("/kb off");
    await m.run("again");
    expect(m.bridge.lastStream.params.knowledge).toEqual([]);
  });

  test("a new chat starts with no bases; the code session keeps its own", async () => {
    const m = await started();
    await m.run("/kb docs");
    await m.c.setKind({ type: "chat" });
    expect(m.c.getState().knowledge).toEqual([]);
    await m.run("/kb notes");
    await m.c.setKind({ type: "code" });
    expect(m.c.getState().knowledge).toEqual(["docs"]);
  });

  test("a /clear in chat starts without the bases", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("/kb docs");
    await m.run("/clear");
    expect(m.c.getState().knowledge).toEqual([]);
  });
});

describe("closing the windows", () => {
  test("the knowledge window refreshes kb.list; a new base joins the suggestions", async () => {
    const m = await started();
    expect(m.bridge.to("kb.list")).toHaveLength(1);
    m.bridge.answers["kb.list"] = { bases: [...BASES, { name: "fresh", description: "" }] };
    m.c.knowledgeClosed();
    await settle();
    expect(m.bridge.to("kb.list")).toHaveLength(2);
    expect(m.c.getState().kbNames).toEqual(["docs", "notes", "fresh"]);
    await m.run("/kb fresh");
    expect(m.bridge.to("code.options").at(-1)!.params).toEqual({ knowledge: ["fresh"] });
  });

  test("closing /mcp under code: any server enabled → code.options {mcp: true}", async () => {
    const m = await started();
    m.bridge.answers["mcp.list"] = { servers: [{ name: "a", enabled: false }, { name: "b", enabled: true }] };
    m.c.mcpClosed();
    await settle();
    expect(m.bridge.to("mcp.list")[0]!.params).toEqual({});
    expect(m.bridge.to("code.options")).toEqual([{ method: "code.options", params: { mcp: true } }]);
    expect(m.c.getState().mcp).toBe(true);
  });

  test("none enabled → {mcp: false}; unchanged → no call", async () => {
    const m = await started({}, { mcp: true });
    m.bridge.answers["mcp.list"] = { servers: [{ name: "a", enabled: false }] };
    m.c.mcpClosed();
    await settle();
    expect(m.bridge.to("code.options")).toEqual([{ method: "code.options", params: { mcp: false } }]);
    m.c.mcpClosed();
    await settle();
    expect(m.bridge.to("code.options")).toHaveLength(1);
  });

  test("under chat, closing /mcp calls nothing on the code session", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    m.bridge.answers["mcp.list"] = { servers: [{ name: "b", enabled: true }] };
    m.c.mcpClosed();
    await settle();
    expect(m.bridge.to("code.options")).toHaveLength(0);
  });

  test("an mcp.list that fails says so", async () => {
    const m = await started();
    m.bridge.answers["mcp.list"] = new Error("config unreadable");
    m.c.mcpClosed();
    await settle();
    expect(m.text()).toContain("config unreadable");
  });
});
