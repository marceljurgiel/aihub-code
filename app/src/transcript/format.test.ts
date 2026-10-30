import { describe, expect, test } from "bun:test";
import { G } from "../glyphs";
import type { Line } from "../scrollback";
import { palette } from "../theme";
import { displayWidth, lineText, lineWidth } from "../width";
import type { DiffEvent, ToolCallEvent, ToolResultEvent } from "./events";
import { FIXTURES as F } from "./fixtures";
import {
  fmtCompaction,
  fmtDiff,
  fmtError,
  fmtHeader,
  fmtNote,
  fmtTodos,
  fmtToolCall,
  fmtToolResult,
  fmtUser,
} from "./format";

const t = (lines: Line[]) => lines.map(lineText);
const fg = (line: Line | undefined, text: string) => line?.find((s) => s.text.includes(text))?.fg;
const wide = (lines: Line[]) => Math.max(0, ...lines.map(lineWidth));

describe("fmtUser", () => {
  test("a prompt starts with the accent >", () => {
    const [line] = fmtUser("fix the failing test in calc.py", 80);
    expect(lineText(line!)).toBe("> fix the failing test in calc.py");
    expect(line![0]).toMatchObject({ text: ">", fg: palette.accent });
  });
  test("lines after the first are indented under the text", () => {
    expect(t(fmtUser("one\ntwo\n\nfour", 80))).toEqual(["> one", "  two", "", "  four"]);
  });
  test("long text wraps with the indent", () => {
    expect(t(fmtUser("alpha beta gamma delta epsilon", 16))).toEqual(["> alpha beta", "  gamma delta", "  epsilon"]);
  });
  test("never wider than the terminal, wide characters included", () => {
    expect(wide(fmtUser("日本語のとても長い文章がここに続きます " + "x".repeat(70), 30))).toBeLessThanOrEqual(30);
  });
  test("control characters are stripped", () => {
    expect(t(fmtUser("a\x1b[31mb\x1b[0m", 40))).toEqual(["> ab"]);
  });
});

describe("fmtToolCall", () => {
  test("● name main-argument", () => {
    expect(t(fmtToolCall(F.tool_call_read, 80))).toEqual([`${G.bullet} read_file calc.py`]);
    expect(t(fmtToolCall(F.tool_call_edit, 80))).toEqual([`${G.bullet} edit_file calc.py`]);
    expect(t(fmtToolCall(F.tool_call_shell, 80))).toEqual([`${G.bullet} run_terminal pytest -q`]);
  });
  test("search shows the pattern and the text it looks for", () => {
    expect(t(fmtToolCall(F.tool_call_search, 80))).toEqual([`${G.bullet} search_files *.py "def add"`]);
    const noText: ToolCallEvent = { name: "search_files", arguments: { root: ".", pattern: "*.md" } };
    expect(t(fmtToolCall(noText, 80))).toEqual([`${G.bullet} search_files *.md`]);
    expect(t(fmtToolCall({ name: "list_files", arguments: { directory: "src" } }, 80))).toEqual([
      `${G.bullet} list_files src`,
    ]);
  });
  test("todo_write is just 'todos'", () => {
    expect(t(fmtToolCall(F.tool_call_todos, 80))).toEqual([`${G.bullet} todos`]);
  });
  test("an unknown tool shows its first text argument; none shows the name", () => {
    expect(t(fmtToolCall({ name: "mail__send", arguments: { n: 3, to: "alex@example.com" } }, 80))).toEqual([
      `${G.bullet} mail__send alex@example.com`,
    ]);
    expect(t(fmtToolCall({ name: "ping", arguments: {} }, 80))).toEqual([`${G.bullet} ping`]);
  });
  test("a multi-line command shows its first line and says there is more", () => {
    const ev: ToolCallEvent = { name: "run_terminal", arguments: { command: "cd src\npytest" } };
    expect(t(fmtToolCall(ev, 80))).toEqual([`${G.bullet} run_terminal cd src …`]);
  });
  test("a long path is cut at the front to fit width 40, keeping the file name", () => {
    const ev: ToolCallEvent = { name: "read_file", arguments: { path: "src/some/really/long/directory/structure/module.py" } };
    const [text] = t(fmtToolCall(ev, 40));
    expect(displayWidth(text!)).toBeLessThanOrEqual(40);
    expect(text!.startsWith(`${G.bullet} read_file …`)).toBe(true);
    expect(text!.endsWith("structure/module.py")).toBe(true);
  });
  test("a long command is cut at the end", () => {
    const ev: ToolCallEvent = { name: "run_terminal", arguments: { command: "pytest -q tests/ --maxfail=1 -k something_long_enough" } };
    const [text] = t(fmtToolCall(ev, 40));
    expect(displayWidth(text!)).toBeLessThanOrEqual(40);
    expect(text!.endsWith("…")).toBe(true);
    expect(text!.startsWith(`${G.bullet} run_terminal pytest -q`)).toBe(true);
  });
  test("a 20-column terminal still gets one line", () => {
    const lines = fmtToolCall(F.tool_call_edit, 20);
    expect(lines).toHaveLength(1);
    expect(lineWidth(lines[0]!)).toBeLessThanOrEqual(20);
  });
  test("arguments that are not an object do not crash it", () => {
    expect(t(fmtToolCall({ name: "read_file", arguments: "oops" as unknown as Record<string, unknown> }, 80))).toEqual([
      `${G.bullet} read_file`,
    ]);
  });
  test("bullet uses the accent, the name is bold", () => {
    const [line] = fmtToolCall(F.tool_call_read, 80);
    expect(line![0]).toMatchObject({ text: G.bullet, fg: palette.accent });
    expect(line!.find((s) => s.text === "read_file")?.bold).toBe(true);
  });
});

describe("fmtToolResult", () => {
  const E = G.elbow;
  test("read: N lines", () => {
    expect(t(fmtToolResult(F.tool_result_read, 80))).toEqual([`  ${E} 12 lines`]);
  });
  test("read: a page of a bigger file says how big", () => {
    const ev: ToolResultEvent = {
      name: "read_file",
      result: "    1\ta\n    2\tb\n[lines 1-2 of 540 — call read_file with offset to read more]",
    };
    expect(t(fmtToolResult(ev, 80))).toEqual([`  ${E} 2 lines (of 540)`]);
  });
  test("read: an empty file", () => {
    expect(t(fmtToolResult({ name: "read_file", result: "(empty file)" }, 80))).toEqual([`  ${E} empty file`]);
  });
  test("search and list: lines, or 'no matches'", () => {
    expect(t(fmtToolResult(F.tool_result_search, 80))).toEqual([`  ${E} 3 lines`]);
    expect(t(fmtToolResult({ name: "search_files", result: "[Search] No files matching '*.rs' found under: /w" }, 80))).toEqual([
      `  ${E} no matches`,
    ]);
    expect(t(fmtToolResult({ name: "list_files", result: "[No files matched '*.rs' in /w]" }, 80))).toEqual([
      `  ${E} no matches`,
    ]);
  });
  test("shell: the last line and the exit code on one row", () => {
    const ev: ToolResultEvent = { name: "run_terminal", result: "3 passed in 0.02s\n[Exit: 0]" };
    const [line, ...rest] = fmtToolResult(ev, 80);
    expect(rest).toEqual([]);
    expect(lineText(line!)).toBe(`  ${E} 3 passed in 0.02s  [exit 0]`);
    expect(fg(line, "[exit 0]")).toBeUndefined();
  });
  test("shell: pytest's two output lines, the exit code after the second", () => {
    expect(t(fmtToolResult(F.tool_result_shell_ok, 80))).toEqual([`  ${E} ...`, "    3 passed in 0.02s  [exit 0]"]);
  });
  test("shell: only the last 3 output lines, [exit 1] in red", () => {
    const lines = fmtToolResult(F.tool_result_shell_fail, 80);
    expect(t(lines)).toEqual([
      `  ${E} calc.py:2: assert 1 == 3`,
      "    E   assert -1 == 3",
      "    1 failed, 1 passed in 0.03s  [exit 1]",
    ]);
    expect(fg(lines[2], "[exit 1]")).toBe(palette.red);
  });
  test("shell: no output is just the exit code; a timeout is not zero", () => {
    expect(t(fmtToolResult({ name: "run_terminal", result: "\n[Exit: 0]" }, 80))).toEqual([`  ${E} [exit 0]`]);
    const lines = fmtToolResult({ name: "run_terminal", result: "waiting\n[Exit: TIMEOUT]", error: "Command exited with TIMEOUT" }, 80);
    expect(t(lines)).toEqual([`  ${E} waiting  [exit TIMEOUT]`]);
    expect(fg(lines[0], "[exit TIMEOUT]")).toBe(palette.red);
  });
  test("shell: blank lines in the output are skipped, long lines cut", () => {
    const ev: ToolResultEvent = { name: "run_terminal", result: `a\n\n${"x".repeat(100)}\n[Exit: 0]` };
    const lines = fmtToolResult(ev, 30);
    expect(wide(lines)).toBeLessThanOrEqual(30);
    expect(t(lines)[0]).toBe(`  ${E} a`);
    expect(t(lines)[1]!.includes("…")).toBe(true);
  });
  test("shell: a result without an exit marker is shown as text", () => {
    expect(t(fmtToolResult({ name: "run_terminal", result: "[Tool Error] 'run_terminal' failed: boom", error: "boom" }, 80))).toEqual([
      `  ${E} [Tool Error] 'run_terminal' failed: boom`,
    ]);
  });
  test("denied: yellow, short", () => {
    const [line] = fmtToolResult(F.tool_result_denied, 80);
    expect(lineText(line!)).toBe(`  ${E} denied`);
    expect(fg(line, "denied")).toBe(palette.yellow);
  });
  test("denied by plan mode says so", () => {
    expect(t(fmtToolResult(F.tool_result_plan_denied, 80))).toEqual([`  ${E} denied (plan mode)`]);
  });
  test("a failed call is red, first line only", () => {
    const lines = fmtToolResult(F.tool_result_error, 80);
    expect(t(lines)).toEqual([`  ${E} [File Error] File not found: /work/nope.py`]);
    expect(fg(lines[0], "[File Error]")).toBe(palette.red);
  });
  test("a long error is cut to the width", () => {
    const ev: ToolResultEvent = { name: "read_file", result: "[File Error] " + "x".repeat(200), error: "e" };
    expect(wide(fmtToolResult(ev, 40))).toBeLessThanOrEqual(40);
  });
  test("edit and todo_write success print nothing: the diff / todo event shows it", () => {
    expect(fmtToolResult(F.tool_result_edit, 80)).toEqual([]);
    expect(fmtToolResult({ name: "todo_write", result: "Todo list updated (1 item)." }, 80)).toEqual([]);
  });
  test("an edit that failed is red", () => {
    const ev: ToolResultEvent = { name: "edit_file", result: "[Edit Error] 'old' text not found in x.py", error: "[Edit Error] 'old' text not found in x.py" };
    const lines = fmtToolResult(ev, 80);
    expect(t(lines)).toEqual([`  ${E} [Edit Error] 'old' text not found in x.py`]);
    expect(fg(lines[0], "[Edit Error]")).toBe(palette.red);
  });
  test("any other tool: one line as it is, many lines as a count", () => {
    expect(t(fmtToolResult({ name: "mail__send", result: "sent" }, 80))).toEqual([`  ${E} sent`]);
    expect(t(fmtToolResult({ name: "mail__list", result: "a\nb\nc" }, 80))).toEqual([`  ${E} 3 lines`]);
    expect(t(fmtToolResult({ name: "mail__list", result: "" }, 80))).toEqual([`  ${E} (no output)`]);
  });
  test("terminal escapes in tool output are stripped", () => {
    const ev: ToolResultEvent = { name: "run_terminal", result: "\x1b[32mgreen\x1b[0m\n[Exit: 0]" };
    expect(t(fmtToolResult(ev, 80))).toEqual([`  ${E} green  [exit 0]`]);
  });
});

describe("fmtDiff", () => {
  const E = G.elbow;
  test("changed lines only, green + and red -, under the elbow", () => {
    const lines = fmtDiff(F.code_diff, 80);
    expect(t(lines)).toEqual([`  ${E} -    return a - b`, "    +    return a + b"]);
    expect(fg(lines[0], "return a - b")).toBe(palette.red);
    expect(fg(lines[1], "return a + b")).toBe(palette.green);
  });
  const big = (n: number, extra: Partial<DiffEvent> = {}): DiffEvent => ({
    path: "big.py",
    text:
      "--- a/big.py\n+++ b/big.py\n@@ -1,3 +1,3 @@\n" +
      Array.from({ length: n }, (_, i) => `+line ${i + 1}`).join("\n") +
      "\n",
    added: n,
    removed: 0,
    created: false,
    ...extra,
  });
  test("15 changed lines: 12 shown, then '… +3 lines'", () => {
    const lines = fmtDiff(big(15), 80);
    expect(lines).toHaveLength(13);
    expect(lineText(lines[11]!)).toBe("    +line 12");
    expect(lineText(lines[12]!)).toBe(`    ${G.ellipsis} +3 lines`);
    expect(lines[12]!.at(-1)!.dim).toBe(true);
  });
  test("exactly 12 shows all, a custom max is honoured", () => {
    expect(fmtDiff(big(12), 80)).toHaveLength(12);
    const lines = fmtDiff(big(15), 80, 5);
    expect(lines).toHaveLength(6);
    expect(lineText(lines[5]!)).toBe(`    ${G.ellipsis} +10 lines`);
  });
  test("a diff the engine already cut counts the lines it dropped", () => {
    const d = big(15, { added: 40, truncated: true });
    const lines = fmtDiff(d, 80);
    expect(lineText(lines[lines.length - 1]!)).toBe(`    ${G.ellipsis} +28 lines`);
  });
  test("a new file: its lines are all +", () => {
    const d: DiffEvent = { path: "new.py", text: "--- a/new.py\n+++ b/new.py\n@@ -0,0 +1,2 @@\n+x = 1\n+y = 2\n", added: 2, removed: 0, created: true };
    expect(t(fmtDiff(d, 80))).toEqual([`  ${E} +x = 1`, "    +y = 2"]);
  });
  test("a content line that looks like a header is still content", () => {
    const d: DiffEvent = { path: "a", text: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n---- old\n+++++ new\n", added: 1, removed: 1, created: false };
    expect(t(fmtDiff(d, 80))).toEqual([`  ${E} ---- old`, "    +++++ new"]);
  });
  test("long lines are cut to the width, tabs expanded", () => {
    const d = big(1);
    d.text = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n+" + "y".repeat(100) + "\n+\ttabbed\n";
    d.added = 2;
    const lines = fmtDiff(d, 30);
    expect(wide(lines)).toBeLessThanOrEqual(30);
    expect(lineText(lines[0]!).endsWith("…")).toBe(true);
    expect(lineText(lines[1]!)).toBe("    +    tabbed");
  });
  test("a binary or large file summary is shown dim", () => {
    const d: DiffEvent = { path: "x.bin", text: "binary or large file (2048 bytes)", added: 0, removed: 0, created: false };
    const lines = fmtDiff(d, 80);
    expect(t(lines)).toEqual([`  ${E} binary or large file (2048 bytes)`]);
    expect(lines[0]!.some((s) => s.dim)).toBe(true);
  });
  test("an error is red; an empty diff says so", () => {
    const lines = fmtDiff({ path: "x", text: "", added: 0, removed: 0, created: false, error: "could not preview: boom" }, 80);
    expect(t(lines)).toEqual([`  ${E} could not preview: boom`]);
    expect(fg(lines[0], "boom")).toBe(palette.red);
    expect(t(fmtDiff({ path: "x", text: "", added: 0, removed: 0, created: false }, 80))).toEqual([`  ${E} no changes`]);
  });
});

describe("fmtTodos", () => {
  test("☒ done, ☐ open, the one in progress bold", () => {
    const lines = fmtTodos(F.code_todos.todos);
    expect(t(lines)).toEqual([
      `  ${G.elbow} ${G.boxDone} write the failing test`,
      `    ${G.boxOpen} fix add()`,
      `    ${G.boxOpen} run the suite`,
    ]);
    expect(lines[1]!.some((s) => s.bold)).toBe(true);
    expect(lines[0]!.some((s) => s.bold)).toBe(false);
    expect(lines[2]!.some((s) => s.bold)).toBe(false);
  });
  test("an empty list", () => {
    expect(t(fmtTodos([]))).toEqual([`  ${G.elbow} no todos`]);
  });
  test("long items are cut to the width", () => {
    const lines = fmtTodos([{ content: "x".repeat(100), status: "pending" }], 30);
    expect(wide(lines)).toBeLessThanOrEqual(30);
  });
});

describe("fmtCompaction", () => {
  test("◇ context compacted 78% → 31% (summary), dim", () => {
    const lines = fmtCompaction(F.code_compaction, 12800);
    expect(t(lines)).toEqual([`${G.diamond} context compacted 78% ${G.arrow} 31% (summary)`]);
    expect(lines[0]!.every((s) => s.dim)).toBe(true);
  });
  test("without the context size it says tokens", () => {
    expect(t(fmtCompaction(F.code_compaction))).toEqual([`${G.diamond} context compacted 10.0k ${G.arrow} 4.0k tokens (summary)`]);
  });
  test("other methods are named", () => {
    expect(t(fmtCompaction({ method: "prune", before: 800, after: 500 }, 1000))).toEqual([
      `${G.diamond} context compacted 80% ${G.arrow} 50% (prune)`,
    ]);
  });
});

describe("fmtError / fmtNote", () => {
  test("✗ message in red", () => {
    const [line] = fmtError("model not found", 80);
    expect(lineText(line!)).toBe(`${G.cross} model not found`);
    expect(line![0]).toMatchObject({ fg: palette.red });
  });
  test("a long message wraps under the text", () => {
    const lines = fmtError(F.chat_error.message, 30);
    expect(wide(lines)).toBeLessThanOrEqual(30);
    expect(lineText(lines[1]!).startsWith("  ")).toBe(true);
    expect(t(lines).join(" ").replace(/\s+/g, " ")).toBe(`${G.cross} ${F.chat_error.message}`);
  });
  test("a note is dim, one line per line of text", () => {
    const lines = fmtNote("mode: plan\nsecond");
    expect(t(lines)).toEqual(["mode: plan", "second"]);
    expect(lines.every((l) => l.every((s) => s.dim))).toBe(true);
  });
  test("a note wraps when given a width", () => {
    expect(wide(fmtNote(F.code_checkpoint_fallback.note, 30))).toBeLessThanOrEqual(30);
  });
});

describe("fmtHeader", () => {
  const info = { version: "0.3.0", model: "gemma4:cloud", mode: "build", root: "/home/alex/my-project", branch: "main", home: "/home/alex" };
  test("the approved header line", () => {
    expect(t(fmtHeader(info, 100))).toEqual([" aihub-code 0.3.0 · gemma4:cloud · build · ~/my-project (main)"]);
  });
  test("no branch, no parentheses; outside the home the path stays absolute", () => {
    expect(t(fmtHeader({ ...info, branch: null }, 100))).toEqual([" aihub-code 0.3.0 · gemma4:cloud · build · ~/my-project"]);
    expect(t(fmtHeader({ ...info, root: "/srv/app", branch: null }, 100))[0]!.endsWith("· /srv/app")).toBe(true);
    expect(t(fmtHeader({ ...info, root: "/home/alex", branch: null }, 100))[0]!.endsWith("· ~")).toBe(true);
  });
  test("a home that is only a prefix of the path is not the home", () => {
    expect(t(fmtHeader({ ...info, root: "/home/alexander/x", branch: null }, 100))[0]!.endsWith("· /home/alexander/x")).toBe(true);
  });
  test("narrow terminals: one line, the path gives way first", () => {
    for (const w of [60, 50, 40, 30, 20]) {
      const lines = fmtHeader(info, w);
      expect(lines).toHaveLength(1);
      expect(lineWidth(lines[0]!)).toBeLessThanOrEqual(w);
    }
    expect(t(fmtHeader(info, 60))[0]!.startsWith(" aihub-code 0.3.0 · gemma4:cloud · build · ")).toBe(true);
    expect(t(fmtHeader(info, 60))[0]).toContain("…");
  });
  test("the name is bold accent, the rest dim", () => {
    const [line] = fmtHeader(info, 100);
    expect(line!.find((s) => s.text.includes("aihub-code"))).toMatchObject({ bold: true, fg: palette.accent });
    expect(line!.find((s) => s.text.includes("gemma4"))?.dim).toBe(true);
  });
});

// The bridge sanitizer turns "\r" into U+240D, so CRLF output reaches the
// formatters as "line␍\n".
const CR = "\u240d";

describe("CRLF output (the sanitizer's \u240d)", () => {
  test("shell rows drop the trailing \u240d of every line", () => {
    const ev: ToolResultEvent = { name: "run_terminal", result: `first${CR}\nsecond${CR}\n[Exit: 0]` };
    expect(t(fmtToolResult(ev, 80))).toEqual([`  ${G.elbow} first`, "    second  [exit 0]"]);
  });
  test("the call line and one-row results drop it too", () => {
    expect(t(fmtToolCall({ name: "run_terminal", arguments: { command: `ls${CR}\npwd` } }, 80))).toEqual([
      `${G.bullet} run_terminal ls ${G.ellipsis}`,
    ]);
    const err: ToolResultEvent = { name: "read_file", result: `[File Error] nope${CR}\nmore`, error: "x" };
    expect(t(fmtToolResult(err, 80))).toEqual([`  ${G.elbow} [File Error] nope`]);
    expect(t(fmtToolResult({ name: "x", result: `done${CR}\n` }, 80))).toEqual([`  ${G.elbow} done`]);
  });
  test("diff lines drop it", () => {
    const d: DiffEvent = { path: "a", text: `--- a\n+++ a\n@@ -1 +1 @@\n-old${CR}\n+new${CR}\n`, added: 1, removed: 1, created: false };
    expect(t(fmtDiff(d, 80))).toEqual([`  ${G.elbow} -old`, "    +new"]);
  });
});

describe("shell [exit N] at narrow widths", () => {
  const cases: [string, string][] = [
    ["a long line of output that will not fit", "[Exit: 0]"],
    ["short", "[Exit: 137]"],
    ["", "[Exit: TIMEOUT]"],
  ];
  for (const width of [20, 14, 10, 8]) {
    test(`no row is wider than ${width}`, () => {
      for (const [out, exit] of cases) {
        const rows = fmtToolResult({ name: "run_terminal", result: `${out}\n${exit}` }, width);
        expect(wide(rows), JSON.stringify(t(rows))).toBeLessThanOrEqual(width);
        expect(t(rows).join("\n")).toContain("[");
      }
    });
  }
  test("the exit code survives, in red when it failed", () => {
    const rows = fmtToolResult({ name: "run_terminal", result: "boom happened here\n[Exit: 2]" }, 14);
    expect(t(rows).join(" ")).toContain("[exit 2]");
    expect(rows.flat().some((s) => s.fg === palette.red && s.text.includes("[exit 2]"))).toBe(true);
  });
});


describe("fmtDiff label", () => {
  test("a label is the first, dim row; the rows follow; the count still fits max", () => {
    const d: DiffEvent = { path: "n.md", text: "--- a/n.md\n+++ b/n.md\n+a\n+b\n+c", added: 3, removed: 0, created: false, label: "new content (the whole file)" };
    const lines = fmtDiff(d, 80, 3);
    expect(t(lines)).toEqual([`  ${G.elbow} new content (the whole file)`, "    +a", "    +b", `    ${G.ellipsis} +1 lines`]);
    expect(lines[0]!.at(-1)!.dim).toBe(true);
  });
  test("a label with no rows replaces 'no changes'", () => {
    const d: DiffEvent = { path: "e", text: "--- a/e\n+++ b/e", added: 0, removed: 0, created: false, label: "new content: an empty file" };
    expect(t(fmtDiff(d, 80))).toEqual([`  ${G.elbow} new content: an empty file`]);
  });
});
