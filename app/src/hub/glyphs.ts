// Ported from AIhub-TUI v1.5.0 app/src/glyphs.ts.
/**
 * Console-safe text on Windows.
 *
 * The Windows console's default font (Consolas) has no ↵ ▎ ✓ ✦ ⌘ … and
 * without font fallback they show up as empty boxes. On Windows every piece of
 * text the app renders goes through `consoleSafe` (see src/jsx/), which swaps
 * those characters for ones Consolas has — one cell for one cell, so layouts
 * keep their widths. AIHUB_GLYPHS=unicode keeps the originals (a terminal with
 * a full font); AIHUB_GLYPHS=ascii-safe forces the swap anywhere (testing).
 */

const CONSOLE_SAFE: Record<string, string> = {
  "↵": "enter",
  "↺": "«",
  "⇄": "↔",
  "⊘": "Ø",
  "⌘": "»",
  "⌫": "bksp",
  "⎿": "└",
  "␛": "^[",
  "␡": "^?",
  "▎": "▌",
  "▣": "■",
  "◆": "♦",
  "◇": "◊",
  "◉": "○",
  "★": "*",
  "⚠": "!",
  "⚲": "!",
  "✓": "√",
  "✗": "×",
  "⨯": "×",
  "✦": "☼",
  "✻": "*",
  // Braille spinner → a classic | / - \ spinner, frame for frame.
  "⠋": "|", "⠙": "/", "⠹": "-", "⠸": "\\", "⠼": "|",
  "⠴": "/", "⠦": "-", "⠧": "\\", "⠇": "|", "⠏": "/",
};

const PATTERN = new RegExp(`[${Object.keys(CONSOLE_SAFE).join("")}]`, "gu");

function wanted(): boolean {
  const mode = process.env.AIHUB_GLYPHS;
  if (mode === "unicode") return false;
  if (mode === "ascii-safe") return true;
  return process.platform === "win32";
}

export const SAFE_GLYPHS = wanted();

export function consoleSafe(text: string): string {
  return text.replace(PATTERN, (c) => CONSOLE_SAFE[c] ?? c);
}

export const CONSOLE_SAFE_MAP: Readonly<Record<string, string>> = CONSOLE_SAFE;
