/**
 * "AIhub CODE" at the top of the transcript when aihub-code starts: AIhub's
 * wordmark (the same rows as AIhub's sidebar) and CODE in the same figlet
 * font ("soft"), beside it when the terminal is wide enough, else under it.
 * A diagonal gradient runs across the letters: the hub theme's logo colours,
 * or in the terminal theme (colours unknown) a light-to-dark run of the
 * accent, readable on dark and light backgrounds alike.
 */
import { flatTheme, logoGradient, logoLines } from "../hub/theme";
import type { Line, Span } from "../scrollback";
import { palette } from "../theme";

export const CODE_LINES = [
  " ,-----. ,-----. ,------.  ,------.",
  "'  .--./'  .-.  '|  .-.  \\ |  .---'",
  "|  |    |  | |  ||  |  \\  :|  `--, ",
  "'  '--'\\'  '-'  '|  '--'  /|  `---.",
  " `-----' `-----' `-------' `------'",
];

const AIHUB_W = Math.max(...logoLines.map((l) => l.length));
const CODE_W = Math.max(...CODE_LINES.map((l) => l.length));
const GAP = 2;
/** Colour steps along the gradient (neighbours of one colour share a span). */
const STEPS = 24;

const HEX = /^#[0-9a-f]{6}$/i;

function mix(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((x >> s) & 255) + (((y >> s) & 255) - ((x >> s) & 255)) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

function stops(): string[] {
  const accent = HEX.test(palette.accent) ? palette.accent : "#a855f7";
  if (!flatTheme()) {
    const own = logoGradient.filter((c): c is string => typeof c === "string" && HEX.test(c));
    if (own.length >= 2) return own;
  }
  return [mix(accent, "#ffffff", 0.45), accent, mix(accent, "#000000", 0.35)];
}

function at(colours: string[], t: number): string {
  const p = Math.min(1, Math.max(0, t)) * (colours.length - 1);
  const i = Math.min(colours.length - 2, Math.floor(p));
  return mix(colours[i]!, colours[i + 1]!, p - i);
}

/** One row of text in gradient spans; spaces stay uncoloured. */
function paint(text: string, row: number, rows: number, cols: number, colours: string[]): Line {
  const spans: Span[] = [];
  const span = (t: string, fg?: string) => {
    const last = spans.at(-1);
    if (last && last.fg === fg) last.text += t;
    else spans.push(fg ? { text: t, fg, bold: true } : { text: t });
  };
  const span0 = rows * 2 + cols;
  [...text].forEach((ch, col) => {
    if (ch === " ") return span(" ");
    const t = Math.round(((col + row * 2) / span0) * STEPS) / STEPS;
    span(ch, at(colours, t));
  });
  return spans;
}

/** The logo, one space in, and a blank row under it; nothing when it can't fit. */
export function fmtLogo(width: number): Line[] {
  if (width < 1 + AIHUB_W) return [];
  const beside = width >= 1 + AIHUB_W + GAP + CODE_W;
  const texts = beside
    ? logoLines.map((l, i) => ` ${l.padEnd(AIHUB_W)}${" ".repeat(GAP)}${CODE_LINES[i] ?? ""}`)
    : [...logoLines, ...CODE_LINES].map((l) => ` ${l}`);
  const colours = stops();
  const cols = Math.max(...texts.map((t) => t.length));
  return [...texts.map((t, row) => paint(t.trimEnd(), row, texts.length, cols, colours)), []];
}
