/**
 * Colours of the line CLI. Plain text uses the terminal's own foreground and
 * background, so it looks right on any terminal theme; only a few semantic
 * colours are fixed. green / red / yellow are slots of the terminal's 16-colour
 * palette ("ansi:N"), which the user's terminal theme already tunes; the
 * accent is AIhub's (a hex), read once from ~/.aihub/config.yaml.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** AIhub's accent names (app/src/theme.ts in AIhub-TUI), purple is its default. */
export const ACCENTS = {
  purple: "#a855f7",
  blue: "#3b82f6",
  cyan: "#06b6d4",
  green: "#10b981",
  amber: "#f59e0b",
  orange: "#f97316",
  pink: "#ec4899",
  red: "#ef4444",
} as const;

export const DEFAULT_ACCENT: string = ACCENTS.purple;

export type Mode = "plan" | "build" | "auto";

export const palette: { accent: string; green: string; red: string; yellow: string } = {
  accent: DEFAULT_ACCENT,
  green: "ansi:2",
  red: "ansi:1",
  yellow: "ansi:3",
};

export function configPath(home: string = homedir()): string {
  return join(home, ".aihub", "config.yaml");
}

/** A top-level scalar of a config file, lower-cased; undefined when the file
 * or the key is missing (an indented key belongs to another section). AIhub's
 * own `theme:` is not read: AIhub always writes one, and aihub-code's theme is
 * its own setting (codeTheme). */
export function configKey(key: "accent", path: string = configPath()): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const m = new RegExp(`^${key}:[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\s#]*))`, "m").exec(text);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
}

/** The accent colour named by `accent:` in a config file, if it is one of
 * AIhub's accents; undefined for anything else (missing file, unknown name). */
export function accentFromConfig(path: string = configPath()): string | undefined {
  const name = configKey("accent", path) ?? "";
  return Object.hasOwn(ACCENTS, name) ? (ACCENTS as Record<string, string>)[name] : undefined;
}

/** aihub-code's own per-user settings, beside its other per-user file
 * (~/.aihub/aihub-code-bridge.err.log); per-project state is in ~/.aihub/projects. */
export function codeSettingsPath(home: string = homedir()): string {
  return join(home, ".aihub", "aihub-code-settings.json");
}

/** The hub theme aihub-code's settings name, lower-cased; undefined when the
 * file is missing or unreadable or names none (then the "terminal" theme). */
export function codeTheme(path: string = codeSettingsPath()): string | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"))?.theme;
    return typeof v === "string" ? v.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Set the live accent from the user's config; the default when there is none.
 * Called once at start-up (tests pass a temp file, never the real home). */
export function applyConfigAccent(path?: string): void {
  palette.accent = accentFromConfig(path) ?? DEFAULT_ACCENT;
}

export function modeColor(mode: string): string {
  if (mode === "plan") return palette.yellow;
  if (mode === "auto") return palette.red;
  return palette.accent;
}
