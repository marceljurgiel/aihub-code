import { describe, expect, test } from "bun:test";
import { G } from "../glyphs";
import { modeColor } from "../theme";
import { displayWidth, lineText, lineWidth } from "../width";
import type { PermissionState } from "../session/controller";
import { activityLine, fmtElapsed } from "./ActivityLine";
import { permissionLayout, permissionTitle } from "./PermissionPrompt";
import { pickerLayout } from "./Picker";
import { slashMatches } from "./SlashSuggest";
import { statusLine } from "./StatusLine";

const perm = (over: Partial<PermissionState> = {}): PermissionState => ({
  requestId: 1,
  permissionId: 9,
  name: "edit_file",
  arguments: { path: "calc.py" },
  diff: null,
  suggestedRule: { tool: "edit_file", pattern: null, scope: "project" },
  mode: "build",
  reason: "",
  hub: false,
  ...over,
});

describe("fmtElapsed", () => {
  test("seconds, then minutes", () => {
    expect(fmtElapsed(0)).toBe("0s");
    expect(fmtElapsed(999)).toBe("0s");
    expect(fmtElapsed(12_400)).toBe("12s");
    expect(fmtElapsed(59_999)).toBe("59s");
    expect(fmtElapsed(65_000)).toBe("1m 05s");
    expect(fmtElapsed(3_600_000)).toBe("60m 00s");
    expect(fmtElapsed(-5)).toBe("0s");
  });
});

describe("activityLine", () => {
  test("spinner, label, seconds and the interrupt hint", () => {
    const line = activityLine({ label: "thinking…", since: 1000 }, 13_000, 60, { interruptible: true });
    expect(lineText(line)).toMatch(/^ \S thinking… 12s · esc to interrupt$/);
    expect(G.spinner).toContain(line[1]!.text);
  });

  test("no hint once interrupted, and the spinner turns with the clock", () => {
    const a = { label: "interrupting…", since: 0 };
    expect(lineText(activityLine(a, 3000, 60, { interruptible: false }))).toMatch(/^ \S interrupting… 3s$/);
    const frames = new Set([0, 80, 160, 240].map((t) => activityLine(a, t, 60, { interruptible: false })[1]!.text));
    expect(frames.size).toBeGreaterThan(1);
  });

  test("fits a narrow terminal", () => {
    const line = activityLine({ label: "running pytest -q tests/test_a_very_long_name.py…", since: 0 }, 5000, 24, { interruptible: true });
    expect(lineWidth(line)).toBeLessThanOrEqual(24);
    expect(lineText(line)).toContain("…");
  });
});

describe("statusLine", () => {
  const base = { mode: "build", model: "m", ctx: { used: 120, limit: 1000 }, queued: 0 };

  test("mode · model · ctx · hints", () => {
    expect(lineText(statusLine(base, 80))).toBe(" build · m · ctx 12% · shift+tab mode · /help");
  });

  test("the mode word carries the mode colour", () => {
    for (const mode of ["plan", "build", "auto"]) {
      const line = statusLine({ ...base, mode }, 80);
      expect(line.find((s) => s.text === mode)?.fg).toBe(modeColor(mode));
    }
  });

  test("no ctx while the limit is unknown", () => {
    expect(lineText(statusLine({ ...base, ctx: { used: 0, limit: 0 } }, 80))).not.toContain("ctx");
  });

  test("queued prompts sit on the right", () => {
    const t = lineText(statusLine({ ...base, queued: 2 }, 70));
    expect(t.endsWith("queued 2")).toBe(true);
    expect(displayWidth(t)).toBe(70);
  });

  test("an armed Ctrl+C replaces the hints", () => {
    const t = lineText(statusLine({ ...base, hint: { text: "Press Ctrl+C again to exit", warn: true } }, 80));
    expect(t).toBe(" build · m · ctx 12% · Press Ctrl+C again to exit");
  });

  test("narrow: hints go first, then the model is cut; never wider than the terminal", () => {
    for (const w of [80, 50, 40, 30, 20, 12, 6, 1]) {
      const line = statusLine({ ...base, model: "gpt-oss:120b-cloud", queued: 3 }, w);
      expect(lineWidth(line)).toBeLessThanOrEqual(w);
    }
    expect(lineText(statusLine(base, 30))).toBe(" build · m · ctx 12%");
  });

  test("ctx rounds, and caps display at 100%", () => {
    expect(lineText(statusLine({ ...base, ctx: { used: 1, limit: 1000 } }, 80))).toContain("ctx 0%");
    expect(lineText(statusLine({ ...base, ctx: { used: 2000, limit: 1000 } }, 80))).toContain("ctx 100%");
  });
});

describe("slashMatches", () => {
  const cmds = [
    { name: "help", hint: "list commands" },
    { name: "mode", hint: "switch mode" },
    { name: "model", hint: "pick a model" },
    { name: "exit", hint: "quit" },
  ];
  test("only while typing the command word", () => {
    expect(slashMatches("/", cmds).map((c) => c.name)).toEqual(["help", "mode", "model", "exit"]);
    expect(slashMatches("/mo", cmds).map((c) => c.name)).toEqual(["mode", "model"]);
    expect(slashMatches("/MO", cmds).map((c) => c.name)).toEqual(["mode", "model"]);
    expect(slashMatches("/mode ", cmds)).toEqual([]);
    expect(slashMatches("/mode plan", cmds)).toEqual([]);
    expect(slashMatches("hello /mo", cmds)).toEqual([]);
    expect(slashMatches("", cmds)).toEqual([]);
    expect(slashMatches("/zzz", cmds)).toEqual([]);
  });
});

describe("permission prompt layout", () => {
  test("titles: Run for a shell command, Allow for the rest", () => {
    expect(permissionTitle(perm(), 60)).toBe("Allow edit_file calc.py?");
    expect(permissionTitle(perm({ name: "run_terminal", arguments: { command: "pytest -q" } }), 60)).toBe("Run pytest -q?");
    expect(permissionTitle(perm({ name: "write_file", arguments: { path: "a/b.txt", content: "x" } }), 60)).toBe("Allow write_file a/b.txt?");
  });

  test("a long command is cut to fit; a multi-line one shows its first line", () => {
    const t = permissionTitle(perm({ name: "run_terminal", arguments: { command: "echo " + "x".repeat(100) } }), 30);
    expect(displayWidth(t)).toBeLessThanOrEqual(30);
    expect(t.endsWith("?")).toBe(true);
    expect(permissionTitle(perm({ name: "run_terminal", arguments: { command: "ls\nrm -rf x" } }), 60)).toBe("Run ls …?");
  });

  test("escapes in the tool's text never reach the screen", () => {
    const t = permissionTitle(perm({ name: "run_terminal", arguments: { command: "echo \u001b[31mred" } }), 60);
    expect(t).not.toContain("\u001b");
  });

  test("options: 2 only with a suggested rule, and it names the rule", () => {
    const withRule = permissionLayout(perm(), 60, 0, false);
    expect(withRule.options.map((o) => o.n)).toEqual([1, 2, 3]);
    expect(lineText(withRule.options[1]!.line)).toContain("don't ask again for edit_file (this project)");
    const without = permissionLayout(perm({ suggestedRule: null }), 60, 0, false);
    expect(without.options.map((o) => o.n)).toEqual([1, 3]); // No keeps its number
    expect(without.options.map((o) => o.kind)).toEqual(["yes", "note"]);
    expect(lineText(without.options[1]!.line)).toContain("3. No");
    const cmd = permissionLayout(
      perm({ name: "run_terminal", arguments: { command: "git status" }, suggestedRule: { tool: "run_terminal", pattern: "git status", scope: "project" } }),
      90, 0, false,
    );
    expect(lineText(cmd.options[1]!.line)).toContain("run_terminal: git status");
  });

  test("the cursor row is marked and bold", () => {
    const l = permissionLayout(perm(), 60, 1, false);
    expect(lineText(l.options[1]!.line).startsWith(`${G.pointer} 2.`)).toBe(true);
    expect(lineText(l.options[0]!.line).startsWith("  1.")).toBe(true);
  });

  test("a diff preview shows at most 10 rows, ellipsis included", () => {
    const text = "--- a/c\n+++ b/c\n@@\n" + Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n");
    const l = permissionLayout(perm({ diff: { path: "c", text, added: 30, removed: 0, created: false } }), 60, 0, false);
    expect(l.diff.length).toBe(10);
    expect(lineText(l.diff[9]!)).toContain("+21 lines");
    const exactly = "--- a/c\n+++ b/c\n@@\n" + Array.from({ length: 10 }, (_, i) => `+line ${i}`).join("\n");
    const e = permissionLayout(perm({ diff: { path: "c", text: exactly, added: 10, removed: 0, created: false } }), 60, 0, false);
    expect(e.diff.length).toBe(10);
    expect(e.diff.map(lineText).join("\n")).not.toContain("more");
  });

  test("every row fits the inner width", () => {
    const l = permissionLayout(
      perm({ name: "run_terminal", arguments: { command: "x".repeat(200) }, suggestedRule: { tool: "run_terminal", pattern: "x".repeat(200), scope: "project" } }),
      30, 0, false,
    );
    for (const row of [l.title, ...l.diff, ...l.options.map((o) => o.line)]) expect(lineWidth(row)).toBeLessThanOrEqual(30);
  });
});

describe("picker layout", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, label: `model-${i}` }));
  test("at most 8 rows, scrolled to keep the cursor in view", () => {
    const top = pickerLayout(items, "", 0, 0, 40);
    expect(top.rows.length).toBe(8);
    expect(lineText(top.rows[0]!)).toContain("model-0");
    const down = pickerLayout(items, "", 12, 0, 40);
    expect(down.rows.length).toBe(8);
    expect(down.rows.map(lineText).join("\n")).toContain("model-12");
    expect(down.top).toBe(5);
    expect(down.summary).toBe("25 of 25");
  });
  test("filter: case-insensitive, all words", () => {
    const l = pickerLayout(items, "MODEL-2", 0, 0, 40);
    expect(l.matches.map((m) => m.id)).toEqual(["m2", "m20", "m21", "m22", "m23", "m24"]);
    expect(pickerLayout(items, "model 3", 0, 0, 40).matches.map((m) => m.id)).toEqual(["m3", "m13", "m23"]);
    expect(pickerLayout(items, "zzz", 0, 0, 40).matches).toEqual([]);
  });
  test("the number of rows depends on the list, not on the filter (steady height)", () => {
    expect(pickerLayout(items.slice(0, 3), "", 0, 0, 40).rows.length).toBe(3);
    expect(pickerLayout(items.slice(0, 3), "model-1", 0, 0, 40).rows.length).toBe(3);
    expect(pickerLayout([], "", 0, 0, 40).rows.length).toBe(1);
  });
  test("the cursor row is marked with the pointer", () => {
    const l = pickerLayout(items, "", 2, 0, 40);
    expect(lineText(l.rows[2]!).startsWith(`${G.pointer} model-2`)).toBe(true);
  });
});
