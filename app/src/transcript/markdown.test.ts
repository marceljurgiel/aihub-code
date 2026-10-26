import { describe, expect, test } from "bun:test";
import { G } from "../glyphs";
import type { Line } from "../scrollback";
import { palette } from "../theme";
import { lineText, lineWidth } from "../width";
import { MarkdownStreamer } from "./markdown";

const t = (lines: Line[]) => lines.map(lineText);
const all = (width: number, chunks: string[]): string[] => {
  const m = new MarkdownStreamer(width);
  return t([...chunks.flatMap((c) => m.feed(c)), ...m.flush()]);
};

describe("MarkdownStreamer: lines", () => {
  test("a line is complete at its newline; the rest waits for flush()", () => {
    const m = new MarkdownStreamer(80);
    expect(t(m.feed("hello\npar"))).toEqual(["hello"]);
    expect(t(m.feed("tial"))).toEqual([]);
    expect(t(m.flush())).toEqual(["partial"]);
    expect(t(m.flush())).toEqual([]);
  });
  test("chunks may split a line anywhere, CRLF is fine", () => {
    expect(all(80, ["he", "llo\r", "\nwor", "ld"])).toEqual(["hello", "world"]);
  });
  test("long lines wrap at the width", () => {
    expect(all(12, ["alpha beta gamma delta\n"])).toEqual(["alpha beta", "gamma delta"]);
  });
  test("no blank lines at the start, at most one in a row, none at the end", () => {
    expect(all(80, ["\n\nfirst\n\n\n\nsecond\n\n"])).toEqual(["first", "", "second"]);
  });
});

describe("MarkdownStreamer: inline", () => {
  test("**bold** and `code`", () => {
    const m = new MarkdownStreamer(80);
    const [line] = m.feed("a **b** c `d` e\n");
    expect(lineText(line!)).toBe("a b c d e");
    expect(line!.find((s) => s.text === "b")?.bold).toBe(true);
    expect(line!.find((s) => s.text === "d")?.fg).toBe(palette.accent);
    expect(line!.find((s) => s.text === "a ")?.bold).toBeFalsy();
  });
  test("unclosed markers stay as typed", () => {
    expect(all(80, ["a **b and `c\n"])).toEqual(["a **b and `c"]);
  });
  test("markers inside code are not formatting", () => {
    const m = new MarkdownStreamer(80);
    const [line] = m.feed("`a **b** c`\n");
    expect(lineText(line!)).toBe("a **b** c");
    expect(line!.some((s) => s.bold)).toBeFalsy();
  });
  test("style survives a wrap", () => {
    const m = new MarkdownStreamer(10);
    const lines = m.feed("x **bold words here** y\n");
    expect(t(lines)).toEqual(["x bold", "words here", "y"]);
    expect(lines[1]!.every((s) => s.bold)).toBe(true);
  });
  test("a heading is bold, without its hashes", () => {
    const m = new MarkdownStreamer(80);
    const [line] = m.feed("## The plan\n");
    expect(lineText(line!)).toBe("The plan");
    expect(line!.every((s) => s.bold)).toBe(true);
  });
});

describe("MarkdownStreamer: lists", () => {
  test("a wrapped item hangs under its text", () => {
    expect(all(14, ["- one two three four\n"])).toEqual(["- one two", "  three four"]);
    expect(all(14, ["1. one two three four\n"])).toEqual(["1. one two", "   three four"]);
  });
  test("nested items keep their indent", () => {
    expect(all(40, ["- a\n  - b\n"])).toEqual(["- a", "  - b"]);
  });
});

describe("MarkdownStreamer: code fences", () => {
  test("code is dim behind a left bar; the fence lines are not shown", () => {
    const m = new MarkdownStreamer(80);
    const lines = m.feed("text\n```python\nx = 1\n\n    y = 2\n```\nafter\n");
    expect(t(lines)).toEqual(["text", `${G.bar} x = 1`, `${G.bar}`, `${G.bar}     y = 2`, "after"]);
    expect(lines[1]!.every((s) => s.dim)).toBe(true);
    expect(lines[0]!.some((s) => s.dim)).toBeFalsy();
  });
  test("a fence split across chunks", () => {
    expect(all(80, ["text\n``", "`py\nx = 1\n", "``", "`\nafter\n"])).toEqual(["text", `${G.bar} x = 1`, "after"]);
  });
  test("markdown inside a fence is left alone", () => {
    const m = new MarkdownStreamer(80);
    const lines = m.feed("```\n**not bold** `x`\n```\n");
    expect(t(lines)).toEqual([`${G.bar} **not bold** \`x\``]);
  });
  test("a long code line wraps with the bar on every row", () => {
    expect(all(10, ["```\nabcdefghijklmnop\n```\n"])).toEqual([`${G.bar} abcdefgh`, `${G.bar} ijklmnop`]);
  });
  test("tabs become spaces", () => {
    expect(all(80, ["```\n\tx\n```\n"])).toEqual([`${G.bar}     x`]);
  });
  test("an unclosed fence ends with the message", () => {
    expect(all(80, ["```\nx = 1\n"])).toEqual([`${G.bar} x = 1`]);
    expect(all(80, ["```\nx = 1"])).toEqual([`${G.bar} x = 1`]);
  });
  test("a ~~~ or indented fence also counts, a fence inside a fence of another kind does not close it", () => {
    expect(all(80, ["~~~\na\n```\nb\n~~~\nc\n"])).toEqual([`${G.bar} a`, `${G.bar} \`\`\``, `${G.bar} b`, "c"]);
  });
});

describe("MarkdownStreamer: safety", () => {
  test("terminal escapes are stripped", () => {
    expect(all(80, ["a\x1b[31mred\x1b[0m b\n"])).toEqual(["ared b"]);
  });
  test("narrow terminals: nothing is wider than the width", () => {
    for (const w of [20, 10, 5]) {
      const m = new MarkdownStreamer(w);
      const out = [...m.feed("# Title is long\n- item with **bold text** and `code`\n```\nlong code line here\n```\n日本語の文章です\n"), ...m.flush()];
      for (const l of out) expect(lineWidth(l)).toBeLessThanOrEqual(w);
    }
  });
});
