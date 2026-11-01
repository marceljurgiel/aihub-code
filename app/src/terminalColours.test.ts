import { afterEach, describe, expect, test } from "bun:test";
import { applyTheme, THEMES } from "./hub/theme";
import { followTheme, RESET, themeColours } from "./terminalColours";

afterEach(() => applyTheme("terminal"));

const nord = THEMES.nord!.palette;
const rgb = (hex: string) => `rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`;

describe("the terminal takes the theme's background and text colour", () => {
  test("a theme with colours sets both (OSC 11 and 10); the terminal theme sets none", () => {
    applyTheme("nord");
    expect(themeColours()).toBe(`\x1b]11;${rgb(String(nord.bg0))}\x07\x1b]10;${rgb(String(nord.fg0))}\x07`);
    applyTheme("terminal");
    expect(themeColours()).toBeNull();
  });

  test("following /theme: set on a change, put back for the terminal theme, nothing twice", () => {
    const out: string[] = [];
    applyTheme("terminal");
    const f = followTheme((s) => out.push(s));
    expect(out).toEqual([]); // the terminal's own colours: nothing to do
    applyTheme("nord");
    applyTheme("nord");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("\x1b]11;");
    applyTheme("terminal");
    expect(out.at(-1)).toBe(RESET);
    f.restore();
    expect(out).toHaveLength(2); // already the terminal's own
  });

  test("the colours chosen at start are set at once, and restore puts the terminal's back", () => {
    const out: string[] = [];
    applyTheme("dracula");
    const f = followTheme((s) => out.push(s));
    expect(out).toHaveLength(1);
    f.restore();
    expect(out.at(-1)).toBe(RESET);
    applyTheme("nord"); // after restore nothing more is written
    expect(out).toHaveLength(2);
  });

  test("a failing write never breaks the app", () => {
    applyTheme("nord");
    const f = followTheme(() => {
      throw new Error("closed");
    });
    expect(() => applyTheme("dracula")).not.toThrow();
    expect(() => f.restore()).not.toThrow();
  });
});
