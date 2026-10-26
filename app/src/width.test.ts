import { describe, expect, test } from "bun:test";
import type { Line } from "./scrollback";
import { displayWidth, lineText, lineWidth, sanitize, splitAtWidth, truncate, truncateStart, wrapSpans } from "./width";

const texts = (lines: Line[]) => lines.map(lineText);

describe("displayWidth", () => {
  test("ASCII is one cell, CJK and emoji two, combining marks none", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("…")).toBe(1);
  });
});

describe("truncate", () => {
  test("keeps what fits, ends with … otherwise", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("hello", 1)).toBe("…");
    expect(truncate("hello", 0)).toBe("");
  });
  test("counts wide characters by cells and never splits one", () => {
    expect(truncate("日本語です", 6)).toBe("日本…");
    expect(displayWidth(truncate("日本語です", 6))).toBeLessThanOrEqual(6);
    expect(truncate("a😀b😀c", 4)).toBe("a😀…");
  });
  test("truncateStart keeps the tail", () => {
    expect(truncateStart("src/very/long/path/calc.py", 14)).toBe("…/path/calc.py");
    expect(truncateStart("calc.py", 14)).toBe("calc.py");
  });
});

describe("sanitize", () => {
  test("strips escape sequences and control characters, expands tabs", () => {
    expect(sanitize("a\x1b[31mred\x1b[0mb")).toBe("aredb");
    expect(sanitize("x\x1b]0;title\x07y")).toBe("xy");
    expect(sanitize("a\tb")).toBe("a    b");
    expect(sanitize("a\r\nb\x00c\x7f")).toBe("a\nbc");
  });
});

describe("wrapSpans", () => {
  test("wraps at word boundaries and keeps styles", () => {
    const out = wrapSpans([{ text: "hello " }, { text: "brave new", bold: true }, { text: " world" }], 11);
    expect(texts(out)).toEqual(["hello brave", "new world"]);
    expect(out[0]!.some((s) => s.bold)).toBe(true);
  });
  test("a word longer than a row is broken", () => {
    expect(texts(wrapSpans([{ text: "abcdefghijkl" }], 5))).toEqual(["abcde", "fghij", "kl"]);
  });
  test("hanging indent on continuation rows", () => {
    expect(texts(wrapSpans([{ text: "- one two three four" }], 10, { indent: "  " }))).toEqual([
      "- one two",
      "  three",
      "  four",
    ]);
  });
  test("leading spaces of the first row are kept, spaces at a wrap are dropped", () => {
    expect(texts(wrapSpans([{ text: "  indented text here" }], 12))).toEqual(["  indented", "text here"]);
  });
  test("never exceeds the width, wide characters included", () => {
    const out = wrapSpans([{ text: "日本語 日本語 日本語 日本語" }], 9);
    for (const l of out) expect(lineWidth(l)).toBeLessThanOrEqual(9);
    expect(texts(out).join(" ")).toBe("日本語 日本語 日本語 日本語");
  });
  test("a hanging indent never pushes a word past the width", () => {
    const out = wrapSpans([{ text: "- item" }], 5, { indent: "  " });
    for (const l of out) expect(lineWidth(l)).toBeLessThanOrEqual(5);
    expect(texts(out).join("").replace(/ /g, "")).toBe("-item");
  });
  test("an empty text is one empty row", () => {
    expect(texts(wrapSpans([{ text: "" }], 10))).toEqual([""]);
  });
});

describe("splitAtWidth", () => {
  test("cuts rows at the width, in the middle of words", () => {
    expect(texts(splitAtWidth([{ text: "ab" }, { text: "cdefg", dim: true }], 3))).toEqual(["abc", "def", "g"]);
  });
  test("short lines pass through, empty stays one empty row", () => {
    expect(texts(splitAtWidth([{ text: "ok" }], 10))).toEqual(["ok"]);
    expect(texts(splitAtWidth([], 10))).toEqual([""]);
  });
});

describe("sanitize with console-safe glyphs", () => {
  test("control pictures and the replacement character become ASCII", () => {
    expect(sanitize("a\u241bb\u2421c\ufffdd", true)).toBe("a^[b^?c?d");
    expect(sanitize("x\u2403y", true)).toBe("x^Cy");
  });
  test("the ideal set keeps them", () => {
    expect(sanitize("a\u241bb\u2421c\ufffdd", false)).toBe("a\u241bb\u2421c\ufffdd");
  });
});

