import { afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeSettingsPath, codeTheme, configKey } from "../theme";
import { CONSOLE_SAFE_MAP } from "./glyphs";
import { DEFAULT_THEME, THEMES, activeTheme, applyTheme, theme } from "./theme";

const dir = mkdtempSync(join(tmpdir(), "aihub-code-hubtheme-"));
let n = 0;
const config = (text: string) => {
  const p = join(dir, `config-${n++}.yaml`);
  writeFileSync(p, text);
  return p;
};
/** What index.tsx does: aihub-code's own theme setting, AIhub's accent. */
const fromConfig = (text: string, settings?: string) => {
  const p = config(text);
  const sp = join(dir, `settings-${n++}.json`);
  if (settings !== undefined) writeFileSync(sp, settings);
  applyTheme(codeTheme(sp), configKey("accent", p));
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
  test("AIhub's own `theme:` in config.yaml is ignored: without an aihub-code setting it is terminal", () => {
    fromConfig("theme: tokyo-night\naccent: green\n");
    expect(activeTheme.name).toBe("terminal");
    expect(theme.bg1).toBe("transparent");
    expect(theme.accent).toBe("#10b981");
  });
  test("aihub-code's own setting picks an AIhub theme; an unknown or broken one is terminal", () => {
    fromConfig("theme: tokyo-night\n", '{"theme":"nord"}');
    expect(activeTheme.name).toBe("nord");
    expect(theme.bg1).toBe(THEMES.nord!.palette.bg1);
    fromConfig("", '{"theme":"neon"}');
    expect(activeTheme.name).toBe("terminal");
    fromConfig("", "{not json");
    expect(activeTheme.name).toBe("terminal");
    fromConfig("", '{"theme":7}');
    expect(activeTheme.name).toBe("terminal");
  });
  test("the setting lives next to aihub-code's other per-user files in ~/.aihub", () => {
    expect(codeSettingsPath("/home/alex")).toBe(join("/home/alex", ".aihub", "aihub-code-settings.json"));
  });
});

test("the window marker has a Windows console fallback (Consolas lacks ◆)", () => {
  expect(CONSOLE_SAFE_MAP["◆"]).toBe("♦");
});
