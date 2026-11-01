import { describe, expect, test } from "bun:test";
import { applyTheme, logoLines } from "../hub/theme";
import { lineText } from "../width";
import { CODE_LINES, fmtLogo } from "./logo";

const AIHUB_W = Math.max(...logoLines.map((l) => l.length));
const CODE_W = Math.max(...CODE_LINES.map((l) => l.length));
const trim = (s: string) => s.trimEnd();

describe("the start-up logo: AIhub CODE", () => {
  test("wide: CODE beside AIhub's wordmark, one space in, then a blank row", () => {
    const rows = fmtLogo(100).map(lineText);
    expect(rows).toHaveLength(logoLines.length + 1);
    logoLines.forEach((l, i) => expect(rows[i]).toBe(trim(` ${l.padEnd(AIHUB_W)}  ${CODE_LINES[i]}`)));
    expect(rows.at(-1)).toBe("");
  });

  test("narrower: CODE under the wordmark", () => {
    const w = 1 + AIHUB_W + 2 + CODE_W - 1;
    const rows = fmtLogo(w).map(lineText);
    expect(rows).toEqual([...logoLines.map((l) => trim(` ${l}`)), ...CODE_LINES.map((l) => trim(` ${l}`)), ""]);
  });

  test("too narrow a terminal gets no logo rather than a broken one", () => {
    expect(fmtLogo(1 + AIHUB_W).length).toBeGreaterThan(0);
    expect(fmtLogo(AIHUB_W)).toEqual([]);
  });

  test("a gradient across the letters, in the terminal theme too", () => {
    for (const name of ["terminal", "aihub"]) {
      applyTheme(name);
      const spans = fmtLogo(100).flat().filter((s) => s.text.trim() !== "");
      expect(spans.every((s) => /^#[0-9a-f]{6}$/i.test(s.fg ?? "") && s.bold)).toBe(true);
      expect(new Set(spans.map((s) => s.fg)).size).toBeGreaterThan(5);
    }
    applyTheme("terminal");
  });
});
