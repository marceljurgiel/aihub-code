import { afterEach, describe, expect, test } from "bun:test";
import { G } from "../glyphs";
import { colour } from "../scrollback";
import { modeColor } from "../theme";
import { INFO, PERM, mount, sleep, unmount, type Mounted } from "./test-utils";

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

const text = (n: Mounted) => n.frame();
const type = async (n: Mounted, s: string) => {
  await n.setup.mockInput.typeText(s);
  await n.settle();
};
const press = async (n: Mounted, name: string, mods: Record<string, boolean> = {}) => {
  if (name === "tab") n.setup.mockInput.pressTab(mods);
  else if (name === "backspace") n.setup.mockInput.pressBackspace(mods);
  else n.setup.mockInput.pressKey(name, mods);
  await n.settle();
};
const enter = async (n: Mounted, mods: Record<string, boolean> = {}) => {
  n.setup.mockInput.pressEnter(mods);
  await n.settle();
};
const esc = async (n: Mounted) => {
  n.setup.mockInput.pressEscape();
  await sleep(60); // OpenTUI waits a moment to tell a lone Esc from a sequence
  await n.settle();
};
const arrow = async (n: Mounted, d: "up" | "down") => {
  n.setup.mockInput.pressArrow(d);
  await n.settle();
};
/** A turn that is running, with the footer showing it. */
async function running(opts: Parameters<typeof mount>[0] = {}) {
  const n = await mount(opts);
  n.c.submit("fix it");
  await n.settle();
  return n;
}
const perms = (n: Mounted) => n.bridge.controls.filter((c) => c.method === "chat.permission").map((c) => c.params);

describe("idle footer", () => {
  test("a rounded box with the caret, and the status line under it", async () => {
    m = await mount();
    expect(m.lines()).toEqual([
      "",
      "╭" + "─".repeat(78) + "╮",
      "│ >" + " ".repeat(76) + "│",
      "╰" + "─".repeat(78) + "╯",
      " build · m · ctx 0% · shift+tab mode · /help",
    ]);
  });

  test("ctx follows the engine's count", async () => {
    m = await running();
    m.bridge.lastStream.emit("code_context", { used: 120, limit: 1000 });
    await m.settle();
    expect(text(m)).toContain("build · m · ctx 12% · shift+tab mode · /help");
  });

  test("the mode word and the box border carry the mode's colour", async () => {
    for (const mode of ["plan", "auto", "build"] as const) {
      const x = await mount({ answers: { "code.start": { ...INFO, mode } } });
      const spans = x.setup.captureSpans().lines.flatMap((l) => l.spans);
      const word = spans.find((s) => s.text.trim() === mode);
      expect(word, `${mode} span`).toBeDefined();
      expect(word!.fg.equals(colour(modeColor(mode)))).toBe(true);
      const corner = spans.find((s) => s.text.includes("╭"));
      // plan and auto tint the box; build keeps the grey one
      expect(corner!.fg.equals(colour(modeColor(mode)))).toBe(mode !== "build");
      unmount(x);
    }
  });

  test("no background fills: every cell uses the terminal's own background", async () => {
    m = await mount();
    const bgs = new Set(m.setup.captureSpans().lines.flatMap((l) => l.spans.map((s) => JSON.stringify(s.bg))));
    expect(bgs.size).toBe(1);
  });
});

describe("typing", () => {
  test("letters are typed, also while a turn runs: no shortcut fires", async () => {
    m = await running();
    const before = m.c.getState();
    await type(m, "p");
    await type(m, "aq?");
    expect(text(m)).toContain("> paq?");
    expect(m.c.getState().phase).toBe("running");
    expect(m.c.getState().picker).toBeNull();
    expect(m.c.getState().mode).toBe(before.mode);
    expect(m.c.getState().queue).toEqual([]);
  });

  test("Enter sends; Enter while running queues; the status shows queued", async () => {
    m = await running();
    await type(m, "next one");
    await enter(m);
    expect(m.submitted).toEqual(["next one"]);
    expect(m.c.getState().queue).toEqual(["next one"]);
    expect(text(m)).toContain("queued 1");
    expect(text(m)).not.toContain("> next one");
  });

  test("an empty or blank prompt is not sent", async () => {
    m = await mount();
    await enter(m);
    await type(m, "   ");
    await enter(m);
    expect(m.submitted).toEqual([]);
  });

  test("Shift+Enter and Ctrl+J add a line; Enter sends all of it", async () => {
    m = await mount();
    await type(m, "one");
    await enter(m, { shift: true });
    await type(m, "two");
    await press(m, "j", { ctrl: true });
    await type(m, "three");
    const l = text(m);
    expect(l).toContain("│ > one");
    expect(l).toContain("│   two");
    expect(l).toContain("│   three");
    await enter(m);
    expect(m.submitted).toEqual(["one\ntwo\nthree"]);
    expect(text(m)).not.toContain("three");
  });

  test("a terminal without the kitty protocol: Ctrl+J still adds a line, Shift+Enter sends", async () => {
    m = await mount({ kitty: false });
    await type(m, "one");
    m.setup.mockInput.pressKey("\n"); // what such a terminal sends for Ctrl+J
    await m.settle();
    await type(m, "two");
    expect(text(m)).toContain("│   two");
    await enter(m, { shift: true }); // indistinguishable from Enter there
    expect(m.submitted).toEqual(["one\ntwo"]);
  });

  test("a bracketed paste keeps its line breaks", async () => {
    m = await mount();
    await m.setup.mockInput.pasteBracketedText("alpha\nbeta");
    await m.settle();
    expect(text(m)).toContain("│ > alpha");
    expect(text(m)).toContain("│   beta");
    await enter(m);
    expect(m.submitted).toEqual(["alpha\nbeta"]);
  });

  test("a long line wraps inside the box", async () => {
    m = await mount({ width: 30 });
    await type(m, "word ".repeat(12));
    const rows = m.lines().filter((x) => x.startsWith("│"));
    expect(rows.length).toBeGreaterThan(2);
    for (const r of m.lines()) expect(r.length).toBeLessThanOrEqual(30);
  });
});

describe("footer height", () => {
  test("grows with the input's lines and shrinks back after sending", async () => {
    m = await mount();
    const base = m.heights.at(-1)!;
    expect(base).toBe(5); // gap, box (3), status
    await type(m, "a");
    await enter(m, { shift: true });
    await type(m, "b");
    expect(m.heights.at(-1)).toBe(base + 1);
    await enter(m, { shift: true });
    await type(m, "c");
    expect(m.heights.at(-1)).toBe(base + 2);
    await enter(m);
    expect(m.heights.at(-1)).toBe(base);
  });

  test("a wrapped line counts; the box stops growing at 8 input rows", async () => {
    m = await mount({ width: 30 });
    await type(m, "word ".repeat(10));
    expect(m.heights.at(-1)).toBeGreaterThan(5);
    for (let i = 0; i < 12; i++) {
      await enter(m, { shift: true });
      await type(m, "x");
    }
    expect(m.heights.at(-1)).toBe(5 + 7);
  });

  test("slash suggestions add rows while they show", async () => {
    m = await mount({ commands: [{ name: "help", hint: "list" }, { name: "mode", hint: "mode" }] });
    await type(m, "/");
    expect(m.heights.at(-1)).toBe(5 + 2);
    await type(m, "h");
    expect(m.heights.at(-1)).toBe(5 + 1);
    await type(m, "zz");
    expect(m.heights.at(-1)).toBe(5);
  });

  test("the rendered footer is exactly as tall as it reports", async () => {
    m = await mount();
    await type(m, "a");
    await enter(m, { shift: true });
    await type(m, "b");
    expect(m.lines().length).toBe(m.heights.at(-1)!);
  });
});

describe("activity line", () => {
  test("a spinner, the label, seconds and the hint, while a turn runs", async () => {
    m = await running();
    m.clock.t += 4000;
    await m.settle();
    await sleep(150); // the clock ticks
    await m.settle();
    expect(m.lines()[0]).toMatch(/^ \S thinking… 4s · esc to interrupt$/);
  });

  test("it leaves when the turn ends, and the row stays", async () => {
    m = await running();
    expect(m.lines()[0]).toContain("thinking…");
    const h = m.heights.at(-1);
    m.bridge.lastStream.finish();
    await m.settle();
    expect(m.lines()[0]).toBe("");
    expect(m.heights.at(-1)).toBe(h!);
  });

  test("after Esc it says interrupting and drops the hint", async () => {
    m = await running();
    await esc(m);
    expect(m.lines()[0]).toMatch(/interrupting…/);
    expect(m.lines()[0]).not.toContain("esc to interrupt");
  });
});

describe("Esc, Ctrl+C, Ctrl+D", () => {
  test("Esc interrupts a running turn and keeps the typed text", async () => {
    m = await running();
    await type(m, "draft");
    await esc(m);
    expect(m.bridge.controls.filter((c) => c.method === "chat.cancel")).toHaveLength(1);
    expect(text(m)).toContain("> draft");
  });

  test("Esc on an idle prompt clears it", async () => {
    m = await mount();
    await type(m, "oops");
    await esc(m);
    expect(text(m)).not.toContain("oops");
    expect(m.exits).toEqual([]);
  });

  test("Ctrl+C interrupts a running turn; another one asks, then exits", async () => {
    m = await running();
    await press(m, "c", { ctrl: true });
    expect(m.bridge.controls.filter((c) => c.method === "chat.cancel")).toHaveLength(1);
    expect(m.exits).toEqual([]);
    await press(m, "c", { ctrl: true }); // still interrupting: the exit path
    expect(text(m)).toContain("Press Ctrl+C again to exit");
    await press(m, "c", { ctrl: true });
    expect(m.exits).toEqual(["exit"]);
  });

  test("Ctrl+C clears typed text first, then asks, then exits", async () => {
    m = await mount();
    await type(m, "something");
    await press(m, "c", { ctrl: true });
    expect(text(m)).not.toContain("something");
    expect(text(m)).not.toContain("Press Ctrl+C");
    await press(m, "c", { ctrl: true });
    expect(text(m)).toContain("Press Ctrl+C again to exit");
    expect(m.exits).toEqual([]);
    await press(m, "c", { ctrl: true });
    expect(m.exits).toEqual(["exit"]);
  });

  test("the question lapses after the window; a late second press only asks again", async () => {
    m = await mount({ ctrlCWindowMs: 60 });
    await press(m, "c", { ctrl: true });
    expect(text(m)).toContain("Press Ctrl+C again to exit");
    await sleep(150);
    await m.settle();
    expect(text(m)).not.toContain("Press Ctrl+C");
    expect(text(m)).toContain("shift+tab mode");
    await press(m, "c", { ctrl: true });
    expect(m.exits).toEqual([]);
    expect(text(m)).toContain("Press Ctrl+C again to exit");
  });

  test("typing disarms the question", async () => {
    m = await mount();
    await press(m, "c", { ctrl: true });
    await type(m, "x");
    expect(text(m)).not.toContain("Press Ctrl+C");
    await press(m, "c", { ctrl: true }); // clears the "x"
    expect(m.exits).toEqual([]);
  });

  test("Ctrl+D exits on an empty prompt only", async () => {
    m = await mount();
    await type(m, "ab");
    await press(m, "d", { ctrl: true });
    expect(m.exits).toEqual([]);
    await esc(m);
    await press(m, "d", { ctrl: true });
    expect(m.exits).toEqual(["exit"]);
  });
});

describe("mode", () => {
  test("Shift+Tab cycles the mode (build, auto, plan, build)", async () => {
    m = await mount();
    await press(m, "tab", { shift: true });
    expect(m.c.getState().mode).toBe("auto");
    expect(text(m)).toContain("auto · m");
    await press(m, "tab", { shift: true });
    expect(m.c.getState().mode).toBe("plan");
    expect(m.bridge.to("code.mode").map((c) => c.params.mode)).toEqual(["auto", "plan"]);
    expect(text(m)).not.toContain("\t");
  });

  test("while a turn runs it is still handled (the controller says it must wait) and types nothing", async () => {
    m = await running();
    await press(m, "tab", { shift: true });
    expect(m.sink.lines.join("\n")).toContain("mode can change when the turn is done");
    expect(text(m)).toContain("│ >");
    expect(text(m)).not.toMatch(/│ > \S/);
  });
});

describe("history", () => {
  test("Up and Down walk the earlier prompts; Down at the end restores the draft", async () => {
    m = await mount();
    for (const t of ["one", "two"]) {
      await type(m, t);
      await enter(m);
    }
    await type(m, "draft");
    await arrow(m, "up");
    expect(text(m)).toContain("> two");
    await arrow(m, "up");
    expect(text(m)).toContain("> one");
    await arrow(m, "up");
    expect(text(m)).toContain("> one"); // the oldest stays
    await arrow(m, "down");
    expect(text(m)).toContain("> two");
    await arrow(m, "down");
    expect(text(m)).toContain("> draft");
    await arrow(m, "down");
    expect(text(m)).toContain("> draft");
  });

  test("a multi-line entry: Up inside it moves the cursor, not the history", async () => {
    m = await mount({ history: ["old"] });
    await type(m, "a");
    await enter(m, { shift: true });
    await type(m, "b");
    await arrow(m, "up"); // cursor goes to line 1
    expect(text(m)).toContain("> a");
    expect(text(m)).not.toContain("old");
    await arrow(m, "up"); // now on the first line: history
    expect(text(m)).toContain("> old");
  });

  test("walking back and forth through two entries", async () => {
    m = await mount({ history: ["old", "older"] });
    await arrow(m, "up");
    await arrow(m, "up");
    expect(text(m)).toContain("> old");
    await arrow(m, "down");
    expect(text(m)).toContain("> older");
  });

  test("history can be seeded", async () => {
    m = await mount({ history: ["from an earlier session"] });
    await arrow(m, "up");
    expect(text(m)).toContain("> from an earlier session");
  });
});

describe("slash commands", () => {
  const commands = [
    { name: "help", hint: "list the commands" },
    { name: "mode", hint: "switch mode" },
    { name: "model", hint: "pick a model" },
  ];

  test("suggestions under the box while typing the command word", async () => {
    m = await mount({ commands });
    await type(m, "/mo");
    const l = m.lines();
    const at = l.findIndex((x) => x.startsWith("╰"));
    expect(l[at + 1]).toContain("/mode");
    expect(l[at + 1]).toContain("switch mode");
    expect(l[at + 2]).toContain("/model");
    expect(l[at + 3]).toContain("shift+tab mode"); // the status line is last
  });

  test("Tab completes the highlighted command; Up/Down choose", async () => {
    m = await mount({ commands });
    await type(m, "/mo");
    await arrow(m, "down");
    await press(m, "tab");
    expect(text(m)).toContain("> /model ");
    expect(text(m)).not.toContain("pick a model");
  });

  test("Enter on a partial command completes it instead of sending", async () => {
    m = await mount({ commands });
    await type(m, "/he");
    await enter(m);
    expect(m.submitted).toEqual([]);
    expect(text(m)).toContain("> /help ");
    await enter(m);
    expect(m.submitted).toEqual(["/help"]);
  });

  test("Enter on an exact command runs it (no second Enter)", async () => {
    m = await mount({ commands });
    await type(m, "/mode");
    await enter(m);
    expect(m.submitted).toEqual(["/mode"]);
  });

  test("no suggestions for text that is not a command word", async () => {
    m = await mount({ commands });
    await type(m, "hello /mo");
    expect(text(m)).not.toContain("switch mode");
  });
});

describe("permission prompt", () => {
  const ask = async (n: Mounted, id: number, extra: Record<string, unknown> = {}) => {
    n.bridge.lastStream.emit("permission_request", PERM(id, extra));
    await n.settle();
  };
  const DIFF = { path: "calc.py", text: "--- a/calc.py\n+++ b/calc.py\n@@\n-return a - b\n+return a + b", added: 1, removed: 1, created: false };

  test("replaces the input box: title, options, hints", async () => {
    m = await running();
    await ask(m, 1);
    const l = text(m);
    expect(l).toContain("Allow edit_file calc.py?");
    expect(l).toContain(`${G.pointer} 1. Yes`);
    expect(l).toContain("2. Yes, and don't ask again for edit_file (this project)");
    expect(l).toContain("3. No, and tell the model what to do instead");
    expect(l).toContain("↑↓ choose · enter confirm · esc no");
    expect(l).not.toContain("│ > ");
    expect(l).toContain("╭");
  });

  test("a shell command reads as a question", async () => {
    m = await running();
    await ask(m, 1, { name: "run_terminal", arguments: { command: "pytest -q" }, suggested_rule: { tool: "run_terminal", pattern: "pytest", scope: "project" } });
    expect(text(m)).toContain("Run pytest -q?");
    expect(text(m)).toContain("don't ask again for run_terminal: pytest (this project)");
  });

  test("option 2 exists only with a suggested rule", async () => {
    m = await running();
    await ask(m, 1, { suggested_rule: null });
    expect(text(m)).not.toContain("2.");
    expect(text(m)).toContain("3. No, and tell");
    await press(m, "2");
    expect(perms(m)).toEqual([]);
    expect(m.c.getState().phase).toBe("permission");
  });

  test("1 allows; 2 allows and remembers; with the shown prompt's id", async () => {
    m = await running();
    await ask(m, 7);
    await press(m, "1");
    expect(perms(m)).toEqual([{ request_id: m.bridge.lastStream.id, allow: true, permission_id: 7 }]);
    expect(m.c.getState().phase).toBe("running");
    await ask(m, 8);
    await press(m, "2");
    expect(perms(m)[1]).toEqual({ request_id: m.bridge.lastStream.id, allow: true, permission_id: 8, remember: "project" });
  });

  test("arrows move the cursor, Enter confirms, the cursor wraps", async () => {
    m = await running();
    await ask(m, 3);
    await arrow(m, "down");
    expect(text(m)).toContain(`${G.pointer} 2. Yes, and`);
    await arrow(m, "down");
    await arrow(m, "down"); // wraps to 1
    expect(text(m)).toContain(`${G.pointer} 1. Yes`);
    await arrow(m, "up"); // wraps to 3
    expect(text(m)).toContain(`${G.pointer} 3. No`);
    await arrow(m, "up");
    await enter(m);
    expect(perms(m)).toEqual([{ request_id: m.bridge.lastStream.id, allow: true, permission_id: 3, remember: "project" }]);
  });

  test("Esc is No", async () => {
    m = await running();
    await ask(m, 4);
    await esc(m);
    expect(perms(m)).toEqual([{ request_id: m.bridge.lastStream.id, allow: false, permission_id: 4 }]);
    expect(m.c.getState().phase).toBe("running");
  });

  test("3 opens the inline input; Enter sends the text with the denial", async () => {
    m = await running();
    await ask(m, 5);
    await press(m, "3");
    expect(text(m)).toContain("Tell the model what to do instead");
    expect(perms(m)).toEqual([]);
    await type(m, "use tabs, not spaces");
    expect(text(m)).toContain("use tabs, not spaces");
    await enter(m);
    expect(perms(m)).toEqual([{ request_id: m.bridge.lastStream.id, allow: false, permission_id: 5, message: "use tabs, not spaces" }]);
  });

  test("digits typed into the inline input are text, not choices", async () => {
    m = await running();
    await ask(m, 5);
    await press(m, "3");
    await type(m, "use 1 file, not 2");
    expect(perms(m)).toEqual([]);
    expect(text(m)).toContain("use 1 file, not 2");
  });

  test("the status line follows the inline input", async () => {
    m = await running();
    await ask(m, 1);
    await press(m, "3");
    expect(text(m)).toContain("enter send · esc back");
    expect(text(m)).not.toContain("↑↓ choose");
    await esc(m);
    expect(text(m)).toContain("↑↓ choose · enter confirm · esc no");
  });

  test("an empty Enter in the inline input is a plain No", async () => {
    m = await running();
    await ask(m, 6);
    await arrow(m, "up"); // wraps to option 3
    await enter(m); // opens the input
    expect(text(m)).toContain("Tell the model what to do instead");
    await enter(m);
    expect(perms(m)).toEqual([{ request_id: m.bridge.lastStream.id, allow: false, permission_id: 6 }]);
  });

  test("Esc in the inline input goes back to the list; a second Esc is No", async () => {
    m = await running();
    await ask(m, 6);
    await press(m, "3");
    await esc(m);
    expect(perms(m)).toEqual([]);
    expect(text(m)).not.toContain("Tell the model");
    expect(text(m)).toContain("3. No, and tell the model what to do instead");
    await esc(m);
    expect(perms(m)).toHaveLength(1);
    expect(perms(m)[0]).toMatchObject({ allow: false, permission_id: 6 });
  });

  test("a second request replaces the first: the answer carries the id on screen", async () => {
    m = await running();
    await ask(m, 1);
    await ask(m, 2, { arguments: { path: "other.py" } });
    expect(text(m)).toContain("Allow edit_file other.py?");
    await press(m, "1");
    expect(perms(m)).toEqual([{ request_id: m.bridge.lastStream.id, allow: true, permission_id: 2 }]);
  });

  test("a second request resets the cursor and an open inline input", async () => {
    m = await running();
    await ask(m, 1);
    await press(m, "3");
    await type(m, "half a sentence");
    await ask(m, 2);
    expect(text(m)).not.toContain("half a sentence");
    expect(text(m)).toContain(`${G.pointer} 1. Yes`);
  });

  test("letters do nothing (and are not typed anywhere)", async () => {
    m = await running();
    await ask(m, 1);
    await type(m, "ay");
    expect(perms(m)).toEqual([]);
    expect(m.c.getState().phase).toBe("permission");
  });

  test("Ctrl+C interrupts the turn and the prompt goes away", async () => {
    m = await running();
    await ask(m, 1);
    await press(m, "c", { ctrl: true });
    expect(m.bridge.controls.filter((c) => c.method === "chat.cancel")).toHaveLength(1);
    expect(text(m)).not.toContain("Allow edit_file");
    expect(perms(m)).toEqual([]);
  });

  test("the draft typed before the prompt came is still there after", async () => {
    m = await running();
    await type(m, "half typed");
    await ask(m, 1);
    expect(text(m)).not.toContain("half typed");
    await press(m, "1");
    expect(text(m)).toContain("> half typed");
  });

  test("a diff preview is shown, 10 rows at most", async () => {
    m = await running();
    await ask(m, 1, { diff: DIFF });
    expect(text(m)).toContain("-return a - b");
    expect(text(m)).toContain("+return a + b");
    await press(m, "1");
    const many = { ...DIFF, text: "--- a/c\n+++ b/c\n@@\n" + Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n"), added: 40, removed: 0 };
    await ask(m, 2, { diff: many });
    const shown = m.lines().filter((x) => /line \d+|more|\+\d+ lines/.test(x));
    expect(shown.length).toBe(10);
    expect(text(m)).toContain("+31 lines");
  });

  test("height grows with the prompt and shrinks back", async () => {
    m = await running();
    const idle = m.heights.at(-1)!;
    await ask(m, 1);
    const asked = m.heights.at(-1)!;
    expect(asked).toBe(1 + 2 + 1 + 3 + 1); // gap, box, title, 3 options, status
    await press(m, "1");
    expect(m.heights.at(-1)).toBe(idle);
    await ask(m, 2, { diff: DIFF });
    expect(m.heights.at(-1)).toBe(asked + 2);
    expect(m.lines().length).toBe(m.heights.at(-1)!);
  });

  test("keys right after the prompt appears are ignored (typed-ahead Enter must not approve)", async () => {
    m = await running({ guardMs: 300 });
    await ask(m, 1);
    await enter(m);
    await press(m, "1");
    expect(perms(m)).toEqual([]);
    m.clock.t += 400;
    await press(m, "1");
    expect(perms(m)).toHaveLength(1);
  });

  test("a narrow terminal: nothing wider than the screen", async () => {
    m = await running({ width: 36 });
    await ask(m, 1, { name: "run_terminal", arguments: { command: "x".repeat(120) }, suggested_rule: { tool: "run_terminal", pattern: "x".repeat(120), scope: "project" }, diff: DIFF });
    for (const l of m.lines()) expect(l.length).toBeLessThanOrEqual(36);
    expect(m.lines().length).toBe(m.heights.at(-1)!);
  });
});

describe("pickers", () => {
  const models = (n: number) => ({ models: Array.from({ length: n }, (_, i) => ({ name: `model-${i}` })) });
  const startPicker = async (n = 12) => {
    const x = await mount({ start: false, answers: { "config.get": {}, ...{ "models.installed": models(n) } } });
    await x.c.start({ cont: false, mcp: [], kb: [] });
    await x.settle();
    return x;
  };

  test("the model picker: title, filter line, 8 rows, a count", async () => {
    m = await startPicker();
    const l = text(m);
    expect(l).toContain("Choose a model");
    expect(l).toContain("model-0");
    expect(l).toContain("model-7");
    expect(l).not.toContain("model-8");
    expect(l).toContain(`${G.pointer} model-0`);
    expect(l).toContain("12 of 12");
    expect(l).toContain("↑↓ choose · enter select · esc cancel");
    expect(l).not.toContain("shift+tab");
    expect(m.lines().length).toBe(m.heights.at(-1)!);
  });

  test("arrows scroll the window; Enter starts a session with the choice", async () => {
    m = await startPicker();
    for (let i = 0; i < 9; i++) await arrow(m, "down");
    expect(text(m)).toContain(`${G.pointer} model-9`);
    expect(text(m)).not.toContain("model-0\n");
    await enter(m);
    await m.settle();
    expect(m.bridge.to("code.start")[0]!.params.model).toBe("model-9");
    expect(m.c.getState().phase).toBe("idle");
    expect(text(m)).toContain("│ >");
  });

  test("typing filters the list; the first match is selected", async () => {
    m = await startPicker();
    await type(m, "model-1");
    const l = text(m);
    expect(l).toContain("model-1");
    expect(l).toContain("model-10");
    expect(l).toContain("model-11");
    expect(l).not.toContain("model-2");
    expect(l).toContain("3 of 12");
    await enter(m);
    expect(m.bridge.to("code.start")[0]!.params.model).toBe("model-1");
  });

  test("nothing matches: a say-so, and Enter does nothing", async () => {
    m = await startPicker();
    await type(m, "zzz");
    expect(text(m)).toContain("no match");
    await enter(m);
    expect(m.bridge.to("code.start")).toEqual([]);
    expect(m.c.getState().phase).toBe("picker");
  });

  test("Esc cancels the model picker (the app exits: there is no model)", async () => {
    m = await startPicker();
    await esc(m);
    expect(m.exits).toEqual(["exit"]);
  });

  test("backspace widens the filter again", async () => {
    m = await startPicker();
    await type(m, "zzz");
    for (let i = 0; i < 3; i++) await press(m, "backspace");
    expect(text(m)).toContain("model-0");
  });

  test("the session picker lists sessions and resumes the chosen one", async () => {
    const x = await mount({
      start: false,
      answers: {
        "code.sessions": { sessions: [{ id: "a", title: "fix calc", turns: 3, updated: "2026-10-26T10:00:00" }, { id: "b", title: "docs", turns: 1, updated: "2026-10-25T09:00:00" }] },
        "code.resume": { ...INFO, session_id: "b", messages: [] },
      },
    });
    m = x;
    await x.c.start({ cont: false, resume: true, mcp: [], kb: [] });
    await x.settle();
    expect(text(x)).toContain("Resume a session");
    expect(text(x)).toContain("fix calc (3 turns");
    await arrow(x, "down");
    await enter(x);
    expect(x.bridge.to("code.resume")[0]!.params.session_id).toBe("b");
  });

  test("labels from the server never carry escape codes", async () => {
    const x = await mount({ start: false, answers: { "config.get": {}, "models.installed": { models: [{ name: "evil\u001b[2Jmodel" }] } } });
    m = x;
    await x.c.start({ cont: false, mcp: [], kb: [] });
    await x.settle();
    expect(text(x)).not.toContain("\u001b");
  });

  test("a narrow terminal: rows fit", async () => {
    const x = await mount({ start: false, width: 30, answers: { "config.get": {}, "models.installed": { models: [{ name: "a-very-long-model-name:with-a-long-tag" }] } } });
    m = x;
    await x.c.start({ cont: false, mcp: [], kb: [] });
    await x.settle();
    for (const l of x.lines()) expect(l.length).toBeLessThanOrEqual(30);
  });
});

describe("narrow terminals", () => {
  test.each([8, 12, 20])("%d columns: nothing crashes, nothing is wider", async (w) => {
    m = await running({ width: w });
    await type(m, "hello world");
    for (const l of m.lines()) expect(l.length).toBeLessThanOrEqual(w);
    m.bridge.lastStream.emit("permission_request", PERM(1, { diff: { path: "c", text: "--- a\n+++ b\n@@\n-x\n+y", added: 1, removed: 1, created: false } }));
    await m.settle();
    for (const l of m.lines()) expect(l.length).toBeLessThanOrEqual(w);
    expect(m.lines().length).toBe(m.heights.at(-1)!);
  });

  test("a 40-column footer keeps to 40 columns, status line included", async () => {
    m = await running({ width: 40 });
    await type(m, "hi");
    for (const l of m.lines()) expect(l.length).toBeLessThanOrEqual(40);
    expect(m.lines().at(-1)).toContain("build");
  });
});
