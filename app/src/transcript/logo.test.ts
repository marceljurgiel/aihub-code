import { describe, expect, test } from "bun:test";
import { logoLines } from "../hub/theme";
import { lineText } from "../width";
import { fmtLogo } from "./logo";

describe("the start-up logo", () => {
  test("AIhub's wordmark, one space in, then a blank row", () => {
    const lines = fmtLogo(80);
    expect(lines.map(lineText)).toEqual([...logoLines.map((l) => ` ${l}`.trimEnd()), ""]);
    expect(lines[0]![0]!.bold).toBe(true);
    expect(lines[0]![0]!.fg).toBeTruthy();
  });

  test("too narrow a terminal gets no logo rather than a broken one", () => {
    expect(fmtLogo(38).length).toBe(logoLines.length + 1);
    expect(fmtLogo(37)).toEqual([]);
  });
});
