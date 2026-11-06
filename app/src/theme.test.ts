import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCENTS, DEFAULT_ACCENT, accentFromConfig, codeAccent, codeTheme, configKey, applyConfigAccent, configPath, modeColor, palette, readCodeSettings, updateCodeSettings } from "./theme";

const dir = mkdtempSync(join(tmpdir(), "aihub-code-theme-"));
let n = 0;
const config = (text: string) => {
  const p = join(dir, `config-${n++}.yaml`);
  writeFileSync(p, text);
  return p;
};

afterEach(() => applyConfigAccent(join(dir, "missing.yaml")));

describe("accent", () => {
  test("a known AIhub accent name in config.yaml wins", () => {
    expect(accentFromConfig(config("ollama_api_url: http://x\naccent: blue\n"))).toBe(ACCENTS.blue);
  });
  test("quotes and trailing comments are tolerated", () => {
    expect(accentFromConfig(config('accent: "green"  # my colour\n'))).toBe(ACCENTS.green);
  });
  test("an unknown name, an empty value, a missing file or a missing key: the default", () => {
    expect(accentFromConfig(config("accent: chartreuse\n"))).toBeUndefined();
    expect(accentFromConfig(config("accent: ''\n"))).toBeUndefined();
    expect(accentFromConfig(config("accent: constructor\n"))).toBeUndefined(); // not a prototype member
    expect(accentFromConfig(config("model: x\n"))).toBeUndefined();
    expect(accentFromConfig(join(dir, "nope.yaml"))).toBeUndefined();
  });
  test("an indented 'accent' under another key is not the setting", () => {
    expect(accentFromConfig(config("theme:\n  accent: red\n"))).toBeUndefined();
  });
  test("applyConfigAccent sets the live palette and falls back to the default", () => {
    applyConfigAccent(config("accent: amber\n"));
    expect(palette.accent).toBe(ACCENTS.amber);
    applyConfigAccent(join(dir, "missing.yaml"));
    expect(palette.accent).toBe(DEFAULT_ACCENT);
  });
  test("the default config path is under the given home", () => {
    expect(configPath("/home/alex")).toBe(join("/home/alex", ".aihub", "config.yaml"));
  });
});

describe("modeColor", () => {
  test("plan is yellow, build the accent, auto red", () => {
    expect(modeColor("plan")).toBe(palette.yellow);
    expect(modeColor("build")).toBe(palette.accent);
    expect(modeColor("auto")).toBe(palette.red);
    expect(modeColor("whatever")).toBe(palette.accent);
  });
  test("build follows the accent from config", () => {
    applyConfigAccent(config("accent: pink\n"));
    expect(modeColor("build")).toBe(ACCENTS.pink);
  });
});

test("semantic colours are terminal palette slots, so they follow the terminal theme", () => {
  expect(palette.green).toBe("ansi:2");
  expect(palette.red).toBe("ansi:1");
  expect(palette.yellow).toBe("ansi:3");
});

describe("codeAccent (aihub-code's own accent setting; config.yaml's is only the fallback)", () => {
  const settings = (text: string) => {
    const p = join(dir, `settings-${n++}.json`);
    writeFileSync(p, text);
    return p;
  };
  test("a name, \"\" (the theme's own) and unset are told apart", () => {
    expect(codeAccent(settings('{"accent":"Blue"}'))).toBe("blue");
    expect(codeAccent(settings('{"accent":""}'))).toBe("");
    expect(codeAccent(settings('{"theme":"nord"}'))).toBeUndefined();
    expect(codeAccent(settings("not json"))).toBeUndefined();
    expect(codeAccent(join(dir, "none.json"))).toBeUndefined();
  });
});

describe("settings files saved with a byte order mark (PowerShell 5.1, Notepad)", () => {
  const BOM = "﻿";
  const file = (name: string, text: string) => {
    const p = join(dir, `bom-${n++}-${name}`);
    writeFileSync(p, BOM + text);
    return p;
  };
  test("aihub-code's settings still name their theme and accent", () => {
    const p = file("settings.json", '{"theme":"Dracula","accent":"teal"}');
    expect(codeTheme(p)).toBe("dracula");
    expect(codeAccent(p)).toBe("teal");
    expect(readCodeSettings(p)).toEqual({ theme: "Dracula", accent: "teal" });
  });
  test("a change keeps what was there (trusting a folder never drops the theme)", () => {
    const p = file("settings.json", '{"theme":"dracula"}');
    updateCodeSettings((doc) => {
      doc.trusted = ["/home/alex/proj"];
    }, p);
    expect(readCodeSettings(p)).toEqual({ theme: "dracula", trusted: ["/home/alex/proj"] });
  });
  test("config.yaml's first key is read too", () => {
    expect(configKey("accent", file("config.yaml", "accent: teal\ntheme: nord\n"))).toBe("teal");
  });
});
