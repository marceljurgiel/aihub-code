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

/** The accent colour named by `accent:` in a config file, if it is one of
 * AIhub's accents; undefined for anything else (missing file, unknown name). */
export function accentFromConfig(path: string = configPath()): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  // A top-level key only: an indented "accent:" belongs to another section.
  const m = /^accent:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#]*))/m.exec(text);
  const name = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim().toLowerCase();
  return Object.hasOwn(ACCENTS, name) ? (ACCENTS as Record<string, string>)[name] : undefined;
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
