import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { Args } from "./args";
import { launch, type Launched } from "./app";
import { MockBridge } from "./session/mock-bridge";

class AppBridge extends MockBridge {
  destroyed = 0;
  destroy() {
    this.destroyed++;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const INFO = {
  session_id: "s1",
  project: { root: "/home/alex/proj", branch: "main", is_git: true },
  mode: "build",
  model: "m",
  context_length: 1000,
};

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;
let open: { setup: Setup; app: Launched } | undefined;
afterEach(() => {
  open?.setup.renderer.destroy();
  open = undefined;
});

async function run(o: { width?: number; height?: number; args?: Partial<Args>; answers?: Record<string, unknown> } = {}) {
  const setup = await createTestRenderer({
    width: o.width ?? 60,
    height: o.height ?? 20,
    screenMode: "split-footer",
    footerHeight: 5,
    externalOutputMode: "capture-stdout",
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  // The headless renderer has no terminal to clear (the real call throws): count the
  // asks, and drop what was written, as a real reset does to the screen.
  const resets: unknown[] = [];
  setup.renderer.resetSplitFooterForReplay = (opts) => {
    resets.push(opts ?? {});
    setup.externalOutput.clear();
  };
  const bridge = new AppBridge();
  bridge.answers["config.get"] = { default_chat_model: "m" };
  bridge.answers["code.start"] = INFO;
  bridge.answers["models.installed"] = { models: [{ name: "m" }] };
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  Object.assign(bridge.answers, o.answers ?? {});
  const closed: (string | null)[] = [];
  const app = launch({ renderer: setup.renderer, bridge, args: { ...ARGS, ...o.args }, cwd: "/home/alex/proj", home: "/home/alex", onClosed: (l) => closed.push(l), resizeQuietMs: 30 });
  open = { setup, app };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await sleep(15);
      await setup.renderOnce();
    }
  };
  /** Rows written above the footer since the last call. */
  const scrolled = async () => {
    await setup.flush();
    return setup.externalOutput.take().flatMap((c) => c.rows.map((r) => r.trimEnd()));
  };
  await settle();
  return { setup, app, bridge, closed, resets, settle, scrolled, frame: () => setup.captureCharFrame().split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "") };
}

describe("the app on a split-footer renderer", () => {
  test("start: the header goes above the footer, the footer is the idle prompt", async () => {
    const t = await run();
    const rows = await t.scrolled();
    expect(rows.join("\n")).toContain("aihub-code");
    expect(rows.join("\n")).toContain("/home/alex/proj".replace("/home/alex", "~"));
    expect(t.frame()).toContain("shift+tab mode");
    expect(t.setup.renderer.footerHeight).toBe(5);
  });

  test("the renderer's footer grows with the input and shrinks back, never past the budget", async () => {
    const t = await run({ height: 14 });
    await t.setup.mockInput.typeText("a");
    for (let i = 0; i < 12; i++) {
      t.setup.mockInput.pressEnter({ shift: true });
      await t.setup.mockInput.typeText("x");
    }
    await t.settle();
    // 14 rows - 5 kept for the transcript
    expect(t.setup.renderer.footerHeight).toBe(9);
    expect(t.frame().split("\n").length).toBeLessThanOrEqual(9);
    await sleep(100);
    expect(t.resets).toEqual([]); // the footer growing is not a terminal resize
  });

  test("a turn's lines reach the scrollback, in order", async () => {
    const t = await run();
    await t.scrolled();
    await t.setup.mockInput.typeText("fix it");
    t.setup.mockInput.pressEnter();
    await t.settle();
    t.bridge.lastStream.emit("text", { text: "Fixed.\n" });
    t.bridge.lastStream.finish();
    await t.settle();
    const rows = await t.scrolled();
    expect(rows.join("\n")).toMatch(/> fix it[\s\S]*Fixed\./);
  });

  test("resuming writes the saved conversation above the footer", async () => {
    const t = await run({
      args: { resume: "s9" },
      answers: {
        "code.resume": {
          ...INFO,
          session_id: "s9",
          messages: [
            { role: "system", content: "s" },
            { role: "user", content: "fix the test" },
            { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: { path: "calc.py" } } }] },
            { role: "tool", tool_call_id: "a", tool_name: "read_file", content: "    1\tx" },
            { role: "assistant", content: "Done." },
          ],
        },
      },
    });
    const rows = (await t.scrolled()).join("\n");
    expect(rows).toMatch(/aihub-code[\s\S]*> fix the test[\s\S]*read_file calc\.py[\s\S]*1 lines[\s\S]*Done\./);
  });

  test("a resize settles, then the whole transcript is written once more at the new width", async () => {
    const t = await run({ width: 60 });
    await t.setup.mockInput.typeText("a long prompt that will have to wrap when the terminal gets narrow");
    t.setup.mockInput.pressEnter();
    await t.settle();
    t.bridge.lastStream.emit("text", { text: "reply one\n" });
    await t.settle();
    await t.scrolled();
    // Rows are written again from the transcript, so what the reset dropped must come back.
    t.setup.resize(30, 20);
    t.setup.resize(31, 20);
    t.setup.resize(32, 20);
    await sleep(120);
    await t.settle();
    expect(t.resets).toEqual([{ clearSavedLines: true }]);
    const rows = await t.scrolled();
    const text = rows.join("\n");
    expect(text.match(/reply one/g)).toHaveLength(1);
    expect(text.match(/aihub-code/g)).toHaveLength(1);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(32);
    expect(text).toContain("> a long prompt");
    expect(rows.indexOf(rows.find((r) => r.includes("aihub-code"))!)).toBeLessThan(rows.findIndex((r) => r.includes("> a long")));
  });

  test("exit: terminal restored, bridge closed, then the resume line", async () => {
    const t = await run();
    await t.setup.mockInput.typeText("hi");
    t.setup.mockInput.pressEnter();
    await t.settle();
    t.bridge.lastStream.finish();
    await t.settle();
    t.app.controller.exit();
    await t.app.closed;
    expect(t.closed).toEqual(["Resume this session: aihub-code --resume s1"]);
    expect((t.bridge as unknown as AppBridge).destroyed).toBe(1);
    t.app.shutdown(); // a second call changes nothing
    expect(t.closed).toHaveLength(1);
    // The renderer blanks the footer's rows on the way out; one row keeps the
    // gap above the shell's next line small.
    expect(t.setup.renderer.footerHeight).toBe(1);
  });

  test("a session nothing was said in is not offered for resume", async () => {
    const t = await run();
    t.app.controller.exit();
    expect(t.closed).toEqual([null]);
  });

  test("exit without a session prints no resume line", async () => {
    const t = await run({ answers: { "code.start": new Error("no model") } });
    t.app.shutdown();
    expect(t.closed).toEqual([null]);
  });
});
