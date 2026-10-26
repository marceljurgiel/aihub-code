import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
import { commandTable } from "../commands";
import { memorySink } from "../scrollback";
import { Controller, kindLabel } from "./controller";
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
};
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const SYS = { role: "system", content: "You are AIhub." };
const RESUME = "Resume this session: aihub-code --resume s1";
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function started() {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud" };
  bridge.answers["code.start"] = (p: Record<string, unknown>) => ({ ...INFO, model: p.model, backend: p.backend ?? "ollama", stream_model: p.stream_model ?? p.model });
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  bridge.answers["chat.start"] = { messages: [SYS] };
  bridge.answers["chat.finalize"] = { path: "/tmp/x.json" };
  bridge.answers["agent.check"] = { ok: true, context: 16384, context_note: "", agent: { name: "reviewer", tools: ["read_file"], permission: "ask", model: "" } };
  const sink = memorySink();
  const resumed: unknown[][] = [];
  const c = new Controller({
    bridge,
    sink,
    commands: commandTable(),
    now: () => 1000,
    width: () => 100,
    cwd: "/home/alex/proj",
    home: "/home/alex",
    onResume: (m) => resumed.push(m),
  });
  await c.start(ARGS);
  const text = () => sink.lines.join("\n");
  const count = (s: string) => sink.lines.filter((l) => l.includes(s)).length;
  /** One code turn, so the code session is worth resuming. */
  const codeTurn = async () => {
    c.submit("fix it");
    await settle();
    bridge.lastStream.finish({});
    await settle();
  };
  const run = async (line: string) => {
    c.submit(line);
    await settle();
  };
  return { bridge, sink, c, text, count, codeTurn, resumed, run };
}

describe("/agent chat", () => {
  test("the old code session's resume line is written once, then chat.start; the next prompt is a chat.turn", async () => {
    const m = await started();
    await m.codeTurn();
    let linesAtStart = -1;
    m.bridge.answers["chat.start"] = () => {
      linesAtStart = m.sink.lines.length;
      return { messages: [SYS] };
    };
    await m.c.setKind({ type: "chat" });
    expect(m.count(RESUME)).toBe(1);
    expect(m.sink.lines.findIndex((l) => l.includes(RESUME))).toBeLessThan(linesAtStart);
    expect(m.bridge.to("chat.start")).toHaveLength(1);
    expect(m.c.getState().kind).toEqual({ type: "chat" });
    expect(m.text()).toContain("chat · gemma4:cloud");

    await m.run("hi");
    const s = m.bridge.lastStream;
    expect(s.method).toBe("chat.turn");
    expect(s.params.agent).toBe(false);
    expect((s.params.messages as unknown[]).at(-1)).toEqual({ role: "user", content: "hi" });
    expect(m.bridge.to("code.turn")).toHaveLength(1);
  });

  test("code → chat → code → chat: the resume line is never written twice, and the exit line is gone", async () => {
    const m = await started();
    await m.codeTurn();
    await m.c.setKind({ type: "chat" });
    expect(m.c.resumableSessionId()).toBe("");
    await m.c.setKind({ type: "code" });
    expect(m.c.getState().kind).toEqual({ type: "code" });
    // The same code session goes on: no new one for the same model.
    expect(m.bridge.to("code.start")).toHaveLength(1);
    await m.c.setKind({ type: "chat" });
    expect(m.count(RESUME)).toBe(1);
    expect(m.c.resumableSessionId()).toBe("");
  });

  test("a code session nothing was said in has no resume line to write", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    expect(m.count("Resume this session")).toBe(0);
  });

  test("a failed chat.start keeps the code kind and says why", async () => {
    const m = await started();
    m.bridge.answers["chat.start"] = new Error("ollama is down");
    await m.c.setKind({ type: "chat" });
    expect(m.c.getState().kind).toEqual({ type: "code" });
    expect(m.c.getState().phase).toBe("idle");
    expect(m.text()).toContain("ollama is down");
    await m.run("go");
    expect(m.bridge.lastStream.method).toBe("code.turn");
  });
});

describe("/agent <profile>", () => {
  test("agent.check first; not ok → 'Agent unavailable: x' and the kind is unchanged", async () => {
    const m = await started();
    m.bridge.answers["agent.check"] = { ok: false, reason: "x" };
    await m.c.setKind({ type: "agent", name: "reviewer", submode: "plan" });
    expect(m.bridge.to("agent.check")[0]!.params).toEqual({ model: "gemma4:cloud", backend: "ollama", agent: "reviewer" });
    expect(m.text()).toContain("Agent unavailable: x");
    expect(m.c.getState().kind).toEqual({ type: "code" });
    expect(m.bridge.to("chat.start")).toHaveLength(0);
  });

  test("ok → turns carry agent:true, the name and the submode; the agent's context is used", async () => {
    const m = await started();
    await m.c.setKind({ type: "agent", name: "reviewer", submode: "plan" });
    expect(m.c.getState().kind).toEqual({ type: "agent", name: "reviewer", submode: "plan" });
    expect(m.c.getState().ctx.limit).toBe(16384);
    expect(m.text()).toContain("agent reviewer · plan · gemma4:cloud");
    expect(m.text()).toContain("Agent reviewer · plan — 16k context");
    await m.run("review calc.py");
    expect(m.bridge.lastStream.method).toBe("chat.turn");
    expect(m.bridge.lastStream.params).toMatchObject({ agent: true, agent_name: "reviewer", submode: "plan", context_length: 16384 });
  });

  test("chat → agent keeps the conversation (AIhub's mode switch), agent → chat too", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("hi");
    m.bridge.lastStream.finish({ messages: [SYS, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
    await settle();
    await m.c.setKind({ type: "agent", name: "reviewer", submode: "build" });
    expect(m.bridge.to("chat.start")).toHaveLength(1);
    await m.run("next");
    expect((m.bridge.lastStream.params.messages as unknown[]).length).toBe(4);
  });
});

describe("switching kind with queued prompts (Review Focus 5)", () => {
  test("code → chat → agent: queued prompts dropped with the 0.2.0 note, resume line once, first turn to the right method", async () => {
    const m = await started();
    await m.run("first");
    const codeTurn = m.bridge.lastStream;
    m.c.submit("queued one");
    m.c.submit("queued two");
    expect(m.c.getState().queue).toEqual(["queued one", "queued two"]);
    const switching = m.c.setKind({ type: "chat" });
    await settle();
    expect(m.bridge.controls).toContainEqual({ method: "chat.cancel", params: { request_id: codeTurn.id } });
    expect(m.text()).toContain("interrupted");
    expect(m.text()).toContain("dropped 2 queued prompts");
    expect(m.c.getState().queue).toEqual([]);
    codeTurn.finish({});
    await switching;
    await settle();
    expect(m.c.getState().kind).toEqual({ type: "chat" });
    expect(m.count(RESUME)).toBe(1);
    // Nothing queued went out on its own.
    expect(m.bridge.streams).toHaveLength(1);

    await m.run("chat one");
    const chatTurn = m.bridge.lastStream;
    expect(chatTurn.method).toBe("chat.turn");
    expect(chatTurn.params.agent).toBe(false);
    m.c.submit("queued three");
    const toAgent = m.c.setKind({ type: "agent", name: "reviewer", submode: "build" });
    await settle();
    expect(m.text()).toContain("dropped 1 queued prompt");
    chatTurn.finish({ messages: [SYS, { role: "user", content: "chat one" }], cancelled: true });
    await toAgent;
    await settle();
    expect(m.bridge.streams).toHaveLength(2);
    await m.run("agent one");
    expect(m.bridge.lastStream.method).toBe("chat.turn");
    expect(m.bridge.lastStream.params).toMatchObject({ agent: true, agent_name: "reviewer" });
    expect(m.count(RESUME)).toBe(1);
  });
});

describe("hub turn events", () => {
  async function chatting() {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("hi");
    return { ...m, turn: m.bridge.lastStream };
  }

  test("round: its text is written as an assistant block when it wasn't streamed; never twice", async () => {
    const m = await chatting();
    m.turn.emit("round", { round: 0, text: "Let me look.", had_tool_calls: true });
    expect(m.count("Let me look.")).toBe(1);
    m.turn.emit("text", { text: "Streamed answer." });
    m.turn.emit("round", { round: 1, text: "Streamed answer.", had_tool_calls: false });
    m.turn.finish({ messages: [] });
    await settle();
    expect(m.count("Streamed answer.")).toBe(1);
  });

  test("knowledge: AIhub's ¶ lines", async () => {
    const m = await chatting();
    m.turn.emit("knowledge", { bases: ["docs"], hits: 2, sources: ["a.md", "b.md"] });
    m.turn.emit("knowledge", { bases: ["docs", "wiki"], hits: 5, sources: ["a", "b", "c", "d"] });
    m.turn.emit("knowledge", { bases: ["docs"], hits: 0, sources: [] });
    m.turn.emit("knowledge", { bases: ["docs"], hits: 0, error: "embeddinggemma missing" });
    const t = m.text();
    expect(t).toContain("¶ docs: 2 excerpts from a.md, b.md");
    expect(t).toContain("¶ docs, wiki: 5 excerpts from a, b, c…");
    expect(t).toContain("¶ docs: nothing relevant found.");
    expect(t).toContain("Knowledge (docs): embeddinggemma missing");
  });

  test("usage feeds /context (prompt tokens are what the context holds)", async () => {
    const m = await chatting();
    m.turn.emit("usage", { prompt_tokens: 2048, completion_tokens: 10, tps: 30 });
    expect(m.c.getState().ctx.used).toBe(2048);
    m.turn.finish({ messages: [] });
    await settle();
    await m.run("/context");
    expect(m.text()).toContain("context: 25% used (2.0k of 8.2k tokens)");
  });

  test("tool calls and results are drawn as in the code agent", async () => {
    const m = await chatting();
    m.turn.emit("tool_call", { call_id: "1", name: "read_file", arguments: { path: "notes.md" } });
    m.turn.emit("tool_result", { call_id: "1", name: "read_file", arguments: { path: "notes.md" }, result: "x", error: null, denied: false });
    expect(m.text()).toContain("notes.md");
  });

  test("an edit's result is said (AIhub's turns send no code_diff to show it)", async () => {
    const m = await chatting();
    m.turn.emit("tool_call", { call_id: "1", name: "write_file", arguments: { path: "note.txt", content: "yo" } });
    m.turn.emit("tool_result", { call_id: "1", name: "write_file", arguments: { path: "note.txt" }, result: "Wrote 2 bytes to note.txt", error: null, denied: false });
    expect(m.text()).toContain("Wrote 2 bytes to note.txt");
  });
});

describe("hub permission", () => {
  async function asked() {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("write it");
    const turn = m.bridge.lastStream;
    turn.emit("permission_request", { name: "write_file", arguments: { path: "notes.md", content: "x" } });
    return { ...m, turn };
  }

  test("a request without permission_id opens the prompt as a hub prompt (no rule, no message)", async () => {
    const m = await asked();
    const p = m.c.getState().permission!;
    expect(m.c.getState().phase).toBe("permission");
    expect(p).toMatchObject({ hub: true, permissionId: null, name: "write_file", suggestedRule: null });
  });

  test("what is approved is shown: write_file's content and edit_file's change as a diff (AIhub shows them in full)", async () => {
    const m = await asked();
    const d = m.c.getState().permission!.diff!;
    expect(d.path).toBe("notes.md");
    expect(d.text.split("\n").slice(2)).toEqual(["+x"]);
    m.c.answer("yes", null);
    m.turn.emit("permission_request", { name: "edit_file", arguments: { path: "a.py", old: "x = 1\ny = 2", new: "x = 3" } });
    expect(m.c.getState().permission!.diff!.text.split("\n").slice(2)).toEqual(["-x = 1", "-y = 2", "+x = 3"]);
  });

  test("yes → chat.permission {request_id, allow:true}, nothing else", async () => {
    const m = await asked();
    m.c.answer("yes", null);
    expect(m.bridge.controls).toEqual([{ method: "chat.permission", params: { request_id: m.turn.id, allow: true } }]);
  });

  test("no → {request_id, allow:false}; a message is never sent (AIhub takes none)", async () => {
    const m = await asked();
    m.c.answer({ no: "do it differently" }, null);
    expect(m.bridge.controls).toEqual([{ method: "chat.permission", params: { request_id: m.turn.id, allow: false } }]);
  });

  test("a request that arrives after the turn was interrupted is refused at once", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("write it");
    const turn = m.bridge.lastStream;
    m.c.cancel();
    turn.emit("permission_request", { name: "write_file", arguments: { path: "x" } });
    expect(m.bridge.controls).toEqual([
      { method: "chat.cancel", params: { request_id: turn.id } },
      { method: "chat.permission", params: { request_id: turn.id, allow: false } },
    ]);
  });
});

describe("Shift+Tab", () => {
  test("under an agent it toggles build/plan; the next turn carries it; no code.mode", async () => {
    const m = await started();
    await m.c.setKind({ type: "agent", name: "reviewer", submode: "build" });
    m.c.cycleMode();
    expect(m.c.getState().kind).toEqual({ type: "agent", name: "reviewer", submode: "plan" });
    m.c.cycleMode();
    expect(m.c.getState().kind).toEqual({ type: "agent", name: "reviewer", submode: "build" });
    m.c.cycleMode();
    await m.run("go");
    expect(m.bridge.lastStream.params.submode).toBe("plan");
    expect(m.bridge.to("code.mode")).toHaveLength(0);
  });

  test("under chat it does nothing", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    const before = m.c.getState();
    m.c.cycleMode();
    expect(m.c.getState().kind).toEqual({ type: "chat" });
    expect(m.c.getState().mode).toBe(before.mode);
    expect(m.bridge.to("code.mode")).toHaveLength(0);
  });
});

describe("finalize", () => {
  test("chat.finalize with auto:true after each hub turn, with the engine's messages", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("hi");
    const done = [SYS, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    m.bridge.lastStream.finish({ messages: done });
    await settle();
    const f = m.bridge.to("chat.finalize");
    expect(f).toHaveLength(1);
    expect(f[0]!.params).toMatchObject({ model: "gemma4:cloud", messages: done, auto: true, backend: "ollama", stream_model: "gemma4:cloud" });
    await m.run("more");
    m.bridge.lastStream.finish({ messages: [...done, { role: "user", content: "more" }, { role: "assistant", content: "ok" }] });
    await settle();
    expect(m.bridge.to("chat.finalize")).toHaveLength(2);
  });

  test("a failed save says so; the chat goes on", async () => {
    const m = await started();
    m.bridge.answers["chat.finalize"] = new Error("disk full");
    await m.c.setKind({ type: "chat" });
    await m.run("hi");
    m.bridge.lastStream.finish({ messages: [SYS, { role: "user", content: "hi" }, { role: "assistant", content: "x" }] });
    await settle();
    expect(m.text()).toContain("Saving the chat failed: disk full");
    expect(m.c.getState().phase).toBe("idle");
  });
});

describe("history", () => {
  const SAVED = [SYS, { role: "user", content: "old question" }, { role: "assistant", content: "old answer" }];

  test("loading a conversation switches to chat with those messages, writes them, and the next turn continues them", async () => {
    const m = await started();
    await m.codeTurn();
    await m.c.loadHistory(SAVED, "2026-10-01T10:00:00");
    expect(m.c.getState().kind).toEqual({ type: "chat" });
    expect(m.resumed).toEqual([SAVED]);
    expect(m.count(RESUME)).toBe(1);
    expect(m.text()).toContain("Resumed session — 2 messages.");
    await m.run("and now?");
    const s = m.bridge.lastStream;
    expect(s.method).toBe("chat.turn");
    expect(s.params.messages).toEqual([...SAVED, { role: "user", content: "and now?" }]);
    s.finish({ messages: [...SAVED, { role: "user", content: "and now?" }, { role: "assistant", content: "x" }] });
    await settle();
    expect(m.bridge.to("chat.finalize")[0]!.params.start_time).toBe("2026-10-01T10:00:00");
  });
});

describe("commands under hub kinds", () => {
  for (const cmd of ["/undo", "/compact", "/todos", "/rules", "/mode plan", "/plan", "/sessions", "/resume"]) {
    test(`${cmd} says it is for the code agent and asks nothing of the code session`, async () => {
      const m = await started();
      await m.c.setKind({ type: "chat" });
      const before = m.bridge.calls.length;
      await m.run(cmd);
      expect(m.text()).toContain("is for the code agent — /agent code switches back");
      expect(m.bridge.calls.slice(before).filter((x) => x.method.startsWith("code."))).toEqual([]);
    });
  }

  test("/agent alone opens the agents panel; /agents too", async () => {
    const m = await started();
    await m.run("/agent");
    expect(m.c.getState().panel).toEqual({ id: "agents" });
    m.c.closePanel();
    await m.run("/agents");
    expect(m.c.getState().panel).toEqual({ id: "agents" });
  });

  test("/agent chat, /agent reviewer plan, /agent code switch directly", async () => {
    const m = await started();
    await m.run("/agent chat");
    expect(m.c.getState().kind).toEqual({ type: "chat" });
    await m.run("/agent reviewer plan");
    expect(m.c.getState().kind).toEqual({ type: "agent", name: "reviewer", submode: "plan" });
    await m.run("/agent code");
    expect(m.c.getState().kind).toEqual({ type: "code" });
    await m.run("go");
    expect(m.bridge.lastStream.method).toBe("code.turn");
  });

  test("/clear under chat starts a new chat (chat.start), not a code session", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("hi");
    m.bridge.lastStream.finish({ messages: [SYS, { role: "user", content: "hi" }, { role: "assistant", content: "x" }] });
    await settle();
    await m.run("/clear");
    expect(m.bridge.to("chat.start")).toHaveLength(2);
    expect(m.bridge.to("code.start")).toHaveLength(1);
    await m.run("fresh");
    expect(m.bridge.lastStream.params.messages).toEqual([SYS, { role: "user", content: "fresh" }]);
  });
});

describe("useModel under hub kinds (AIhub: a new chat on the new model)", () => {
  test("the current chat is finalized, a new one starts on the new model in plain chat; no code session", async () => {
    const m = await started();
    await m.c.setKind({ type: "agent", name: "reviewer", submode: "build" });
    await m.run("hi");
    m.bridge.lastStream.finish({ messages: [SYS, { role: "user", content: "hi" }, { role: "assistant", content: "x" }] });
    await settle();
    const saves = m.bridge.to("chat.finalize").length;
    await m.c.useModel({ name: "llama3.2:3b", backend: "ollama" });
    expect(m.bridge.to("chat.finalize").length).toBe(saves + 1);
    expect(m.bridge.to("chat.start").at(-1)!.params).toEqual({ model: "llama3.2:3b", messages: [] });
    expect(m.bridge.to("code.start")).toHaveLength(1);
    expect(m.c.getState()).toMatchObject({ model: "llama3.2:3b", kind: { type: "chat" } });
    await m.run("hello");
    expect(m.bridge.lastStream.params).toMatchObject({ model: "llama3.2:3b", agent: false });
    expect(m.bridge.lastStream.params.messages).toEqual([SYS, { role: "user", content: "hello" }]);
  });

  test("/model picker under chat: the picked model starts a new chat, not a code session", async () => {
    const m = await started();
    m.bridge.answers["models.installed"] = { models: [{ name: "gemma4:cloud" }, { name: "llama3.2:3b" }] };
    m.bridge.answers["cloud.models"] = { models: [] };
    await m.c.setKind({ type: "chat" });
    await m.run("/model");
    expect(m.c.getState().picker?.kind).toBe("model");
    await m.c.pick("llama3.2:3b");
    await settle();
    expect(m.bridge.to("chat.start").at(-1)!.params).toEqual({ model: "llama3.2:3b", messages: [] });
    expect(m.bridge.to("code.start")).toHaveLength(1);
    expect(m.c.getState()).toMatchObject({ model: "llama3.2:3b", kind: { type: "chat" }, phase: "idle", picker: null });
  });

  test("back to code after a model change: a new code session on that model", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.c.useModel({ name: "gpt-x", backend: "api", streamModel: "https://api.example/v1/gpt-x" });
    await m.c.setKind({ type: "code" });
    expect(m.bridge.to("code.start").at(-1)!.params).toMatchObject({ model: "gpt-x", backend: "api", stream_model: "https://api.example/v1/gpt-x" });
    expect(m.c.getState().kind).toEqual({ type: "code" });
  });
});

describe("kindLabel (the status line's first word)", () => {
  test("code shows its mode; chat says chat; an agent its name and submode", () => {
    expect(kindLabel({ type: "code" }, "plan")).toBe("plan");
    expect(kindLabel({ type: "chat" }, "build")).toBe("chat");
    expect(kindLabel({ type: "agent", name: "reviewer", submode: "plan" }, "auto")).toBe("agent reviewer · plan");
  });
});
