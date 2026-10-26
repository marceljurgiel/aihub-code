import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
import { memorySink } from "../scrollback";
import { commandTable } from "../commands";
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
};
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

async function started() {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud" };
  bridge.answers["code.start"] = (p: Record<string, unknown>) => ({ ...INFO, model: p.model, backend: p.backend ?? "ollama", stream_model: p.stream_model ?? p.model });
  bridge.answers["config.set"] = (p: any) => ({ ...p.patch });
  const sink = memorySink();
  const c = new Controller({ bridge, sink, commands: commandTable(), now: () => 1000, width: () => 100, cwd: "/home/alex/proj", home: "/home/alex" });
  await c.start(ARGS);
  const text = () => sink.lines.join("\n");
  return { bridge, sink, c, text };
}

describe("useModel (code kind)", () => {
  test("a local model: a new code session on it, with the new-session divider", async () => {
    const { c, bridge, text } = await started();
    await c.useModel({ name: "llama3.2:3b", backend: "ollama" });
    const last = bridge.to("code.start").at(-1)!;
    expect(last.params).toMatchObject({ model: "llama3.2:3b", backend: "ollama" });
    expect(c.getState().model).toBe("llama3.2:3b");
    expect(text()).toContain("new session with llama3.2:3b");
  });

  test("an API model: backend and stream model go to code.start and into the state", async () => {
    const { c, bridge } = await started();
    await c.useModel({ name: "gpt-x", backend: "api", streamModel: "https://api.example/v1/gpt-x" });
    expect(bridge.to("code.start").at(-1)!.params).toMatchObject({ model: "gpt-x", backend: "api", stream_model: "https://api.example/v1/gpt-x" });
    expect(c.getState()).toMatchObject({ model: "gpt-x", backend: "api", streamModel: "https://api.example/v1/gpt-x" });
  });

  test("the state follows the session's own answer (backend, temperature)", async () => {
    const { c } = await started();
    expect(c.getState()).toMatchObject({ backend: "ollama", temperature: 0.7 });
  });

  test("a running turn blocks it (the session is not replaced under it)", async () => {
    const { c, bridge } = await started();
    c.submit("go");
    await settle();
    await c.useModel({ name: "llama3.2:3b", backend: "ollama" });
    expect(bridge.to("code.start")).toHaveLength(1);
  });

  test("a failed start keeps the old session and says why", async () => {
    const { c, bridge, text } = await started();
    bridge.answers["code.start"] = new Error("no such model");
    await c.useModel({ name: "nope", backend: "ollama" });
    expect(c.getState()).toMatchObject({ model: "gemma4:cloud", phase: "idle" });
    expect(text()).toContain("no such model");
  });
});

describe("setTemperature", () => {
  test("rounds to 0.1, saves through config.set, says so", async () => {
    const { c, bridge, text } = await started();
    await c.setTemperature(0.75);
    expect(bridge.to("config.set").at(-1)!.params).toEqual({ patch: { temperature: 0.8 } });
    expect(c.getState().temperature).toBe(0.8);
    expect(text()).toContain("Temperature → 0.8.");
  });

  test("a failed save keeps the old value and reports it", async () => {
    const { c, bridge, text } = await started();
    bridge.answers["config.set"] = new Error("disk full");
    await c.setTemperature(1.2);
    expect(c.getState().temperature).toBe(0.7);
    expect(text()).toContain("Saving the temperature");
    expect(text()).toContain("disk full");
  });

  test("/temp 0.75 does the same; junk is refused", async () => {
    const { c, bridge, text } = await started();
    await c.runCommand("temp", "0.75");
    expect(bridge.to("config.set").at(-1)!.params).toEqual({ patch: { temperature: 0.8 } });
    expect(text()).toContain("Temperature → 0.8.");
    await c.runCommand("temp", "hot");
    expect(bridge.to("config.set")).toHaveLength(1);
    expect(text()).toContain("Temperature is a number from 0 to 2");
    await c.runCommand("temp", "5");
    expect(bridge.to("config.set")).toHaveLength(1);
  });
});
