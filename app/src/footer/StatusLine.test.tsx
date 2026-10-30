import { afterEach, describe, expect, test } from "bun:test";
import { CODE } from "../session/kinds";
import { locationText, statusItems } from "../session/status";
import type { ControllerState } from "../session/controller";
import { mount, until, unmount, type Mounted } from "./test-utils";

type S = Pick<ControllerState, "kind" | "mode" | "model" | "ctx" | "knowledge" | "mcp" | "taskRunning">;
const base: S = { kind: CODE, mode: "build", model: "gemma4:cloud", ctx: { used: 500, limit: 1000 }, knowledge: [], mcp: false, taskRunning: null };
const full: S = { ...base, knowledge: ["notes", "docs"], mcp: true, taskRunning: "backup" };

describe("statusItems", () => {
  test("model · location, the kind and mode, ctx, kb / mcp, the running task, in that order", () => {
    expect(statusItems(full, "GPU 100% 6G", 200)).toEqual(["gemma4:cloud · GPU 100% 6G", "build", "ctx 50%", "kb:2 mcp:on", "task backup\u2026"]);
  });

  test("no location, no kb or mcp, no task, no ctx limit: those items are simply absent", () => {
    expect(statusItems({ ...base, ctx: { used: 0, limit: 0 } }, null, 200)).toEqual(["gemma4:cloud", "build"]);
  });

  test("chat and agent kinds name themselves", () => {
    expect(statusItems({ ...base, kind: { type: "chat" } }, null, 200)[1]).toBe("chat");
    expect(statusItems({ ...base, kind: { type: "agent", name: "writer", submode: "plan" } }, null, 200)[1]).toBe("agent writer · plan");
  });

  test("items drop from the end until the line fits: at width 60 only the first two remain", () => {
    const agent: S = { ...full, kind: { type: "agent", name: "researcher", submode: "build" } };
    const items = statusItems(agent, "GPU 100% 6G", 60);
    expect(items).toEqual(["gemma4:cloud · GPU 100% 6G", "agent researcher · build"]);
    // And the line (a leading space, the items joined by " · ") fits.
    expect(1 + items.join(" · ").length).toBeLessThanOrEqual(60);
  });

  test("a very narrow line keeps a cut model rather than nothing", () => {
    const items = statusItems(full, "GPU 100% 6G", 12);
    expect(items).toHaveLength(1);
    expect(1 + items[0]!.length).toBeLessThanOrEqual(12);
  });

  test("the location carries AIhub's wording", () => {
    expect(locationText({ state: "gpu", gpu_fraction: 1, vram_gb: 6, size_gb: 6 })).toBe("GPU 100% 6.0G");
    expect(locationText({ state: "split", gpu_fraction: 0.4, vram_gb: 2, size_gb: 5 })).toBe("GPU 40% · CPU 60%");
    expect(locationText({ state: "cpu", gpu_fraction: 0, vram_gb: 0, size_gb: 5 })).toBe("CPU");
    expect(locationText({ state: "unloaded" })).toBe("not loaded");
    expect(locationText({ state: "cloud" })).toBe("cloud");
    expect(locationText(null)).toBeNull();
  });
});

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

describe("the status line in the footer", () => {
  test("shows where the model runs, asked of the engine (models.location)", async () => {
    m = await mount({ answers: { "models.location": { state: "gpu", gpu_fraction: 1, vram_gb: 6, size_gb: 6 } } });
    const mm = m;
    await until(() => mm.frame().includes("m · GPU 100% 6.0G"), mm.settle);
    expect(mm.bridge.calls.some((c) => c.method === "models.location" && c.params.model === "m")).toBe(true);
    expect(mm.frame()).toContain("m · GPU 100% 6.0G · build · ctx 0%");
  });

  test("an unknown answer (offline, no model) says nothing", async () => {
    m = await mount({ answers: { "models.location": { state: "unknown" } } });
    await m.settle();
    expect(m.frame()).toContain(" m · build · ctx 0%");
    expect(m.frame()).not.toContain("GPU");
  });

  test("it is asked again after each reply, and not while one streams", async () => {
    m = await mount({ answers: { "models.location": { state: "cloud" } } });
    const mm = m;
    const asked = () => mm.bridge.calls.filter((c) => c.method === "models.location").length;
    await until(() => asked() >= 1, mm.settle);
    const before = asked();
    mm.c.submit("hello");
    await mm.settle();
    expect(asked()).toBe(before); // streaming: not asked
    mm.bridge.lastStream.finish({ messages: [] });
    await until(() => asked() > before, mm.settle);
  });
});
