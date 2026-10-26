import { describe, expect, test } from "bun:test";
import { asciiControls, FONT_CHECK, G, makeGlyphs, resolveSafe, type Glyphs } from "./glyphs";

const KEYS = Object.keys(makeGlyphs(false)).filter((k) => k !== "spinner") as Exclude<keyof Glyphs, "spinner">[];

describe("glyphs", () => {
  test("the ideal set is the approved look", () => {
    const g = makeGlyphs(false);
    expect(g.bullet).toBe("●");
    expect(g.elbow).toBe("⎿");
    expect(g.diamond).toBe("◇");
    expect(g.boxOpen).toBe("☐");
    expect(g.boxDone).toBe("☒");
    expect(g.cross).toBe("✗");
    expect([g.tl, g.tr, g.bl, g.br]).toEqual(["╭", "╮", "╰", "╯"]);
    expect([g.h, g.v]).toEqual(["─", "│"]);
    expect(g.ellipsis).toBe("…");
    expect(g.pointer).toBe("❯");
  });

  test("console-safe set swaps the characters the Windows fonts lack", () => {
    const g = makeGlyphs(true);
    expect(g.bullet).toBe("●"); // in Consolas and Cascadia: kept
    expect(g.elbow).toBe("└");
    expect(g.diamond).toBe("◊");
    expect(g.boxOpen).toBe("[ ]");
    expect(g.boxDone).toBe("[x]");
    expect(g.cross).toBe("×");
    expect(g.pointer).toBe(">"); // ❯ is not in Consolas
    expect([g.tl, g.tr, g.bl, g.br]).toEqual(["╭", "╮", "╰", "╯"]);
  });

  test("every console-safe glyph is ASCII or in both Windows console fonts", () => {
    const g = makeGlyphs(true);
    const chars = [...KEYS.flatMap((k) => [...g[k]]), ...g.spinner.flatMap((f) => [...f])];
    for (const c of chars) {
      if (c.charCodeAt(0) < 128) continue;
      const fonts = FONT_CHECK[c];
      expect(fonts, `${c} (U+${c.codePointAt(0)!.toString(16)}) has no font-check entry`).toBeDefined();
      expect(fonts!.consolas && fonts!.cascadia, `${c} missing in a Windows console font`).toBe(true);
    }
  });

  test("a glyph a font lacks always has a different fallback", () => {
    const ideal = makeGlyphs(false);
    const safe = makeGlyphs(true);
    for (const k of KEYS) {
      for (const c of [...ideal[k]]) {
        const fonts = FONT_CHECK[c];
        if (c.charCodeAt(0) < 128 || (fonts && fonts.consolas && fonts.cascadia)) continue;
        expect(safe[k], `${k} (${c}) has no fallback`).not.toBe(ideal[k]);
      }
    }
  });

  test("spinner frames: braille ideally, a classic spinner when console-safe", () => {
    expect(makeGlyphs(false).spinner).toHaveLength(10);
    expect(makeGlyphs(false).spinner[0]).toBe("⠋");
    expect(makeGlyphs(true).spinner).toEqual(["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"]);
  });

  test("resolveSafe: env override, else the platform decides", () => {
    expect(resolveSafe({ AIHUB_GLYPHS: "unicode" }, "win32")).toBe(false);
    expect(resolveSafe({ AIHUB_GLYPHS: "ascii-safe" }, "linux")).toBe(true);
    expect(resolveSafe({}, "win32")).toBe(true);
    expect(resolveSafe({}, "linux")).toBe(false);
    expect(resolveSafe({}, "darwin")).toBe(false);
  });

  test("the characters the bridge sanitizer produces are in the font check", () => {
    // consola.ttf lacks the control pictures and U+FFFD; Cascadia has them. The
    // em dash is in both.
    for (const c of ["\u240d", "\u241b", "\u2421", "\ufffd"]) expect(FONT_CHECK[c]).toEqual({ consolas: false, cascadia: true });
    expect(FONT_CHECK["—"]).toEqual({ consolas: true, cascadia: true });
  });

  test("asciiControls maps what the console fonts lack to ASCII", () => {
    expect(asciiControls("a\u241bb\u2421c\ufffdd\u2403e")).toBe("a^[b^?c?d^Ce");
    expect(asciiControls("plain — text")).toBe("plain — text");
  });

  test("G is one of the two sets", () => {
    expect([makeGlyphs(false).bullet, makeGlyphs(true).bullet]).toContain(G.bullet);
  });
});
