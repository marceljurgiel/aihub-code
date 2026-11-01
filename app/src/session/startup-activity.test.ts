import { describe, expect, test } from "bun:test";
import type { Args } from "../args";
import { memorySink } from "../scrollback";
import { Controller } from "./controller";
import { MockBridge } from "./mock-bridge";

const INFO = { session_id: "s1", project: { root: "/home/alex/proj", is_git: true }, mode: "build", model: "m", context_length: 1000 };
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

class SlowBridge extends MockBridge {
  release!: () => void;
  private gate = new Promise<void>((r) => (this.release = r));
  override async ready() {
    await this.gate;
    return { version: this.version };
  }
}

function pending<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function make(bridge = new MockBridge(), model = "m") {
  bridge.answers["config.get"] = { default_chat_model: model };
  bridge.answers["code.start"] = INFO;
  bridge.answers["models.installed"] = { models: [{ name: "m" }, { name: "x" }] };
  const c = new Controller({ bridge, sink: memorySink(), width: () => 80, cwd: "/home/alex/proj", home: "/home/alex" });
  return { bridge, c };
}

describe("start-up says what it is waiting for", () => {
  test("the engine coming up, then the models, then the session", async () => {
    const bridge = new SlowBridge();
    const { c } = make(bridge);
    const models = pending<unknown>();
    const session = pending<unknown>();
    bridge.answers["models.installed"] = () => models.promise;
    bridge.answers["code.start"] = () => session.promise;
    const started = c.start(ARGS);
    await settle();
    expect(c.getState().activity?.label).toBe("starting…");
    bridge.release();
    await settle();
    expect(c.getState().activity?.label).toBe("loading models…");
    models.resolve({ models: [{ name: "m" }] });
    await settle();
    expect(c.getState().activity?.label).toBe("starting the session…");
    session.resolve(INFO);
    await started;
    expect(c.getState().phase).toBe("idle");
    expect(c.getState().activity).toBeNull();
  });

  test("a model the server lacks: the picker opens on the list already fetched", async () => {
    const { bridge, c } = make(undefined, "gone:1b");
    await c.start(ARGS);
    expect(c.getState().phase).toBe("picker");
    expect(c.getState().picker?.items.map((i) => i.id)).toEqual(["m", "x"]);
    expect(c.getState().activity).toBeNull();
    expect(bridge.to("models.installed")).toHaveLength(1);
  });

  test("no model set up: loading models…, then the picker", async () => {
    const { bridge, c } = make(undefined, "");
    const models = pending<unknown>();
    bridge.answers["models.installed"] = () => models.promise;
    const started = c.start(ARGS);
    await settle();
    expect(c.getState().activity?.label).toBe("loading models…");
    models.resolve({ models: [{ name: "m" }] });
    await started;
    expect(c.getState().phase).toBe("picker");
    expect(c.getState().activity).toBeNull();
  });

  test("a failed start leaves no activity behind", async () => {
    const { bridge, c } = make();
    bridge.answers["code.start"] = new Error("boom");
    await c.start(ARGS);
    expect(c.getState().phase).toBe("error");
    expect(c.getState().activity).toBeNull();
  });
});
