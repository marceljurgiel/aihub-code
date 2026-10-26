/**
 * Text measuring and wrapping by display width: wide characters (CJK, emoji)
 * take two cells, combining marks none. Pure helpers shared by the formatters
 * and the scrollback sink.
 */
import { asciiControls, SAFE_GLYPHS } from "./glyphs";
import type { Line, Span } from "./scrollback";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);

export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

export const lineText = (line: Line): string => line.map((s) => s.text).join("");
export const lineWidth = (line: Line): number => displayWidth(lineText(line));

const ELLIPSIS = "…";

/** Fit `text` into `max` cells; a cut ends with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  let out = "";
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = displayWidth(g);
    if (w + gw > max - 1) break;
    out += g;
    w += gw;
  }
  return out + ELLIPSIS;
}

/** Like `truncate`, but keeps the end (the interesting part of a path). */
export function truncateStart(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  const gs = graphemes(text);
  let out = "";
  let w = 0;
  for (let i = gs.length - 1; i >= 0; i--) {
    const gw = displayWidth(gs[i]!);
    if (w + gw > max - 1) break;
    out = gs[i]! + out;
    w += gw;
  }
  return ELLIPSIS + out;
}

// CSI, OSC (BEL or ST terminated) and any other two-byte escape.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;

/** Tool output and model text are untrusted: no escapes or control codes may
 * reach the terminal through the transcript. Tabs become four spaces. With
 * console-safe glyphs the bridge's control pictures (␛ ␡ �) turn into ASCII. */
export function sanitize(text: string, safe: boolean = SAFE_GLYPHS): string {
  const clean = text
    .replace(ESCAPES, "")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  return safe ? asciiControls(clean) : clean;
}

/** The bridge sanitizer turns "\r" into U+240D: drop it where a CRLF line ends. */
export const stripCR = (line: string): string => line.replace(/\u240d+$/, "");

const sameStyle = (a: Span, b: Span) => a.fg === b.fg && !!a.bold === !!b.bold && !!a.dim === !!b.dim;

function push(row: Span[], style: Span, text: string): void {
  if (!text) return;
  const last = row[row.length - 1];
  if (last && sameStyle(last, style)) last.text += text;
  else row.push({ ...style, text });
}

function trimEnd(row: Span[]): Span[] {
  while (row.length) {
    const last = row[row.length - 1]!;
    const t = last.text.replace(/ +$/, "");
    if (t === "") row.pop();
    else {
      last.text = t;
      break;
    }
  }
  return row;
}

/** Break a line into rows of at most `width` cells, mid-word if need be. Used
 * for lines that are already formatted: the sink's safety net. */
export function splitAtWidth(line: Line, width: number): Line[] {
  const w = Math.max(1, width);
  const rows: Line[] = [];
  let row: Span[] = [];
  let used = 0;
  for (const span of line) {
    for (const g of graphemes(span.text)) {
      const gw = displayWidth(g);
      if (used + gw > w && used > 0) {
        rows.push(row);
        row = [];
        used = 0;
      }
      push(row, span, g);
      used += gw;
    }
  }
  rows.push(row);
  return rows;
}

/**
 * Word-wrap styled spans to `width`. `indent` prefixes every row after the
 * first (a hanging indent). Words longer than a row are broken; spaces at a
 * wrap are dropped, spaces at the start of the first row are kept.
 */
export function wrapSpans(spans: Span[], width: number, opts: { indent?: string } = {}): Line[] {
  const indent = opts.indent ?? "";
  const w = Math.max(1, width);
  const rows: Line[] = [];
  let row: Span[] = [];
  let used = 0;
  let first = true;

  const newRow = () => {
    rows.push(trimEnd(row));
    row = [];
    first = false;
    used = 0;
    if (indentWidth) {
      row.push({ text: indent });
      used = indentWidth;
    }
  };
  const indentWidth = displayWidth(indent) < w ? displayWidth(indent) : 0;
  const atRowStart = () => used === (first ? 0 : indentWidth);

  for (const span of spans) {
    for (const tok of span.text.split(/( +)/)) {
      if (tok === "") continue;
      const tw = displayWidth(tok);
      if (tok.startsWith(" ")) {
        if (atRowStart() && !first) continue; // dropped at a wrap
        if (used + tw > w) {
          newRow();
          continue;
        }
        push(row, span, tok);
        used += tw;
        continue;
      }
      if (used + tw <= w) {
        push(row, span, tok);
        used += tw;
        continue;
      }
      if (tw <= w - indentWidth && !atRowStart()) {
        newRow(); // the word fits a fresh row
        push(row, span, tok);
        used += tw;
        continue;
      }
      // Longer than a row: fill what is left, then break by character.
      for (const g of graphemes(tok)) {
        const gw = displayWidth(g);
        if (used + gw > w && !atRowStart()) newRow();
        push(row, span, g);
        used += gw;
      }
    }
  }
  rows.push(trimEnd(row));
  return rows;
}
