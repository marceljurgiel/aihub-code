/**
 * Glyphs the transcript and the footer draw, with console-safe fallbacks.
 *
 * The Windows console's fonts (Consolas, Cascadia Mono) lack some of the
 * characters we like; without font fallback they show up as empty boxes. On
 * Windows the app uses the console-safe set below, one cell for one cell, so
 * layouts keep their widths. AIHUB_GLYPHS=unicode keeps the ideal set (a
 * terminal with a full font); AIHUB_GLYPHS=ascii-safe forces the swap anywhere.
 *
 * FONT_CHECK records the result of checking every non-ASCII character against
 * consola.ttf and CascadiaMono.ttf (fontTools getBestCmap, 2026-10-26, the
 * aihub-live-check recipe). The tests insist that the console-safe set uses
 * only ASCII or characters present in both fonts.
 */

export const FONT_CHECK: Readonly<Record<string, { consolas: boolean; cascadia: boolean }>> = {
  "●": { consolas: true, cascadia: true },
  "⎿": { consolas: false, cascadia: false },
  "◇": { consolas: false, cascadia: true },
  "☐": { consolas: false, cascadia: false },
  "☒": { consolas: false, cascadia: false },
  "✗": { consolas: false, cascadia: false },
  "╭": { consolas: true, cascadia: true },
  "╮": { consolas: true, cascadia: true },
  "╰": { consolas: true, cascadia: true },
  "╯": { consolas: true, cascadia: true },
  "│": { consolas: true, cascadia: true },
  "─": { consolas: true, cascadia: true },
  "…": { consolas: true, cascadia: true },
  "→": { consolas: true, cascadia: true },
  "·": { consolas: true, cascadia: true },
  "└": { consolas: true, cascadia: true },
  "◊": { consolas: true, cascadia: true },
  "×": { consolas: true, cascadia: true },
  "⠋": { consolas: false, cascadia: true },
  "⠙": { consolas: false, cascadia: true },
  "⠹": { consolas: false, cascadia: true },
  "⠸": { consolas: false, cascadia: true },
  "⠼": { consolas: false, cascadia: true },
  "⠴": { consolas: false, cascadia: true },
  "⠦": { consolas: false, cascadia: true },
  "⠧": { consolas: false, cascadia: true },
  "⠇": { consolas: false, cascadia: true },
  "⠏": { consolas: false, cascadia: true },
};

export interface Glyphs {
  /** Tool call marker. */
  bullet: string;
  /** Result connector under a tool call. */
  elbow: string;
  /** Compaction marker. */
  diamond: string;
  /** Todo, not done / done. */
  boxOpen: string;
  boxDone: string;
  /** Error marker. */
  cross: string;
  /** Rounded box corners and rules. */
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  ellipsis: string;
  arrow: string;
  /** Header separator. */
  sep: string;
  /** Left bar of a code block. */
  bar: string;
  spinner: string[];
}

const IDEAL: Glyphs = {
  bullet: "●",
  elbow: "⎿",
  diamond: "◇",
  boxOpen: "☐",
  boxDone: "☒",
  cross: "✗",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
  ellipsis: "…",
  arrow: "→",
  sep: "·",
  bar: "│",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

// Only the entries that differ from IDEAL: what Consolas lacks.
const CONSOLE_SAFE: Partial<Glyphs> = {
  elbow: "└",
  diamond: "◊",
  boxOpen: "[ ]",
  boxDone: "[x]",
  cross: "×",
  // The braille spinner becomes a classic | / - \ spinner, frame for frame.
  spinner: ["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"],
};

export function makeGlyphs(safe: boolean): Glyphs {
  return { ...IDEAL, ...(safe ? CONSOLE_SAFE : {}), spinner: [...(safe ? CONSOLE_SAFE.spinner! : IDEAL.spinner)] };
}

export function resolveSafe(env: Record<string, string | undefined>, platform: string): boolean {
  if (env.AIHUB_GLYPHS === "unicode") return false;
  if (env.AIHUB_GLYPHS === "ascii-safe") return true;
  return platform === "win32";
}

export const SAFE_GLYPHS = resolveSafe(process.env, process.platform);

export const G: Glyphs = makeGlyphs(SAFE_GLYPHS);
