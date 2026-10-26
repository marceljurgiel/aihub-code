import { describe, expect, test } from "bun:test";
import { HubChat, agentNote } from "./hubChat";
import { MockBridge } from "./mock-bridge";

const SYS = { role: "system", content: "You are AIhub." };

function make() {
  const bridge = new MockBridge();
  bridge.answers["chat.start"] = { messages: [SYS] };
  const chat = new HubChat(bridge, { model: "gemma4:cloud", backend: "ollama", streamModel: "gemma4:cloud" });
  return { bridge, chat };
}

describe("HubChat", () => {
  test("start: chat.start with the model and no messages; keeps the system message it returns", async () => {
    const { bridge, chat } = make();
    await chat.start();
    expect(bridge.to("chat.start")).toEqual([{ method: "chat.start", params: { model: "gemma4:cloud", messages: [] } }]);
    expect(chat.messages).toEqual([SYS]);
  });

  test("params: exactly v1.5.0 ChatScreen's chat.turn params, in plain chat", async () => {
    const { chat } = make();
    await chat.start();
    chat.temperature = 0.4;
    chat.contextLength = 16384;
    const p = chat.params("hi", []);
    expect(Object.keys(p).sort()).toEqual(
      ["agent", "agent_name", "backend", "context_length", "knowledge", "messages", "model", "stream_model", "submode", "temperature", "tools_enabled"].sort(),
    );
    expect(p).toEqual({
      model: "gemma4:cloud",
      stream_model: "gemma4:cloud",
      backend: "ollama",
      messages: [SYS, { role: "user", content: "hi" }],
      temperature: 0.4,
      context_length: 16384,
      tools_enabled: true,
      agent: false,
      agent_name: "",
      submode: "build",
      knowledge: [],
    });
  });

  test("params under an agent: agent true, its name and submode; images go on the user message", async () => {
    const { chat } = make();
    await chat.start();
    chat.kind = { type: "agent", name: "reviewer", submode: "plan" };
    const p = chat.params("look", ["img-1"]);
    expect(p).toMatchObject({ agent: true, agent_name: "reviewer", submode: "plan" });
    expect((p.messages as unknown[]).at(-1)).toEqual({ role: "user", content: "look", images: ["img-1"] });
  });

  test("the user message stays in the conversation (as AIhub's outgoing); accept takes the engine's copy", async () => {
    const { chat } = make();
    await chat.start();
    chat.params("hi", []);
    expect(chat.messages.at(-1)).toEqual({ role: "user", content: "hi" });
    const after = [SYS, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    chat.accept(after);
    expect(chat.messages).toEqual(after);
    chat.accept(undefined);
    expect(chat.messages).toEqual(after);
  });

  test("finalize: chat.finalize as ChatScreen 158 (model, messages, temperature, start_time, backend, stream_model, auto)", async () => {
    const { bridge, chat } = make();
    await chat.start();
    chat.params("hi", []);
    await chat.finalize(true);
    expect(bridge.to("chat.finalize")).toEqual([
      {
        method: "chat.finalize",
        params: {
          model: "gemma4:cloud",
          messages: chat.messages,
          temperature: 0.7,
          start_time: chat.startTime,
          backend: "ollama",
          stream_model: "gemma4:cloud",
          auto: true,
        },
      },
    ]);
  });

  test("load: a saved conversation and its own start time (autosave keeps updating its file)", () => {
    const { chat } = make();
    const saved = [SYS, { role: "user", content: "old" }, { role: "assistant", content: "reply" }];
    chat.load(saved, "2026-10-01T10:00:00");
    expect(chat.messages).toEqual(saved);
    expect(chat.startTime).toBe("2026-10-01T10:00:00");
    expect((chat.params("more", []).messages as unknown[]).length).toBe(4);
  });

  test("agentNote: AIhub's line on entering an agent, with aihub-code's keys", () => {
    const text = agentNote(
      { name: "reviewer", tools: ["read_file", "search_files", "kb:docs"], permission: "auto", model: "llama3.2:3b" },
      "plan",
      { context: 32000, context_note: "fits" },
      "gemma4:cloud",
      8192,
    );
    expect(text).toBe(
      "Agent reviewer · plan — 32k context (fits). Tools: read grep; asks before edits and commands.  This agent suggests llama3.2:3b (/models).  /agent to switch.",
    );
  });
});
