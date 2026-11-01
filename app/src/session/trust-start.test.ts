import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
import { memorySink } from "../scrollback";
import { Controller } from "./controller";
import { MockBridge } from "./mock-bridge";
import type { TrustStore } from "./trust";

const INFO = { session_id: "s1", project: { root: "/home/alex/proj", is_git: true }, mode: "build", model: "m", context_length: 1000 };
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function make(trusted: string[] = [], saveFails = false) {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "m" };
  bridge.answers["code.start"] = INFO;
  bridge.answers["models.installed"] = { models: [{ name: "m" }] };
  const saved: string[] = [];
  const trust: TrustStore = {
    trusted: (dir) => trusted.includes(dir),
    trust: (dir) => {
      if (saveFails) throw new Error("read-only file system");
      saved.push(dir);
    },
  };
  const sink = memorySink();
  const exits: string[] = [];
  const c = new Controller({ bridge, sink, width: () => 80, cwd: "/home/alex/proj", home: "/home/alex", trust, onExit: () => exits.push("exit") });
  return { bridge, sink, c, saved, exits };
}

describe("do you trust this folder?", () => {
  test("an untrusted folder asks first: nothing of the project is opened meanwhile", async () => {
    const { bridge, c } = make();
    void c.start(ARGS);
    await settle();
    expect(c.getState().phase).toBe("trust");
    expect(c.getState().trust).toEqual({ dir: "~/proj" });
    expect(bridge.to("code.start")).toEqual([]);
    expect(bridge.to("code.sessions")).toEqual([]);
  });

  test("yes: the folder is remembered and the session starts", async () => {
    const { bridge, c, saved } = make();
    const started = c.start(ARGS);
    await settle();
    c.answerTrust(true);
    await started;
    expect(saved).toEqual(["/home/alex/proj"]);
    expect(c.getState().trust).toBeNull();
    expect(c.getState().phase).toBe("idle");
    expect(bridge.to("code.start")).toHaveLength(1);
  });

  test("no: aihub-code leaves without starting anything", async () => {
    const { bridge, c, exits, saved } = make();
    const started = c.start(ARGS);
    await settle();
    c.answerTrust(false);
    await started;
    expect(exits).toEqual(["exit"]);
    expect(saved).toEqual([]);
    expect(bridge.to("code.start")).toEqual([]);
  });

  test("a trusted folder is not asked about", async () => {
    const { bridge, c } = make(["/home/alex/proj"]);
    await c.start(ARGS);
    expect(c.getState().trust).toBeNull();
    expect(bridge.to("code.start")).toHaveLength(1);
  });

  test("when the answer can't be saved, this run goes on and says so", async () => {
    const { sink, c } = make([], true);
    const started = c.start(ARGS);
    await settle();
    c.answerTrust(true);
    await started;
    expect(c.getState().phase).toBe("idle");
    expect(sink.lines.join("\n")).toContain("could not remember this folder: read-only file system");
  });

  test("a second answer does nothing", async () => {
    const { c, saved, exits } = make();
    const started = c.start(ARGS);
    await settle();
    c.answerTrust(true);
    c.answerTrust(false);
    await started;
    expect(saved).toEqual(["/home/alex/proj"]);
    expect(exits).toEqual([]);
  });
});
