import { afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configKey } from "../theme";
import { CONSOLE_SAFE_MAP } from "./glyphs";
import { DEFAULT_THEME, THEMES, activeTheme, applyTheme, theme } from "./theme";

const dir = mkdtempSync(join(tmpdir(), "aihub-code-hubtheme-"));
let n = 0;
const config = (text: string) => {
  const p = join(dir, `config-${n++}.yaml`);
  writeFileSync(p, text);
  return p;
};
const fromConfig = (text: string) => {
  const p = config(text);
  applyTheme(configKey("theme", p), configKey("accent", p));
};

afterEach(() => applyTheme());

describe("hub theme (ruling R-P1)", () => {
  test("no theme key in config.yaml: the terminal theme — no backgrounds, the terminal's own text colour", () => {
    fromConfig("ollama_api_url: http://x\n");
    expect(DEFAULT_THEME).toBe("terminal");
    expect(activeTheme.name).toBe("terminal");
    for (const k of ["bg0", "bg1", "bg2", "bg3"] as const) expect(theme[k]).toBe("transparent");
    expect(theme.fg0).toEqual(RGBA.defaultForeground());
  });
  test("the accent still follows config.yaml in the terminal theme", () => {
    fromConfig("accent: blue\n");
    expect(activeTheme.name).toBe("terminal");
    expect(theme.accent).toBe("#3b82f6");
  });
  test("a named AIhub theme is used as is; an unknown one falls back to terminal", () => {
    fromConfig('theme: "Nord"  # mine\n');
    expect(activeTheme.name).toBe("nord");
    expect(theme.bg1).toBe(THEMES.nord!.palette.bg1);
    fromConfig("theme: neon\n");
    expect(activeTheme.name).toBe("terminal");
  });
  test("configKey reads top-level keys only", () => {
    expect(configKey("theme", config("ui:\n  theme: nord\n"))).toBeUndefined();
    expect(configKey("theme", join(dir, "missing.yaml"))).toBeUndefined();
  });
});

test("the window marker has a Windows console fallback (Consolas lacks ◆)", () => {
  expect(CONSOLE_SAFE_MAP["◆"]).toBe("♦");
});
