/**
 * Light markdown for streamed assistant text: fed chunks in, finished lines
 * out. A line is formatted only once its newline arrived, so formatting never
 * has to be taken back. Supported: fenced code (dim behind a left bar),
 * **bold**, `inline code`, # headings, list items that wrap under their text.
 * Everything else is plain text, wrapped to the width.
 */
import { G } from "../glyphs";
import type { Line, Span } from "../scrollback";
import { palette } from "../theme";
import { displayWidth, sanitize, splitAtWidth, stripCR, wrapSpans } from "../width";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;

/** `code` takes the accent colour, **bold** is bold; unmatched markers stay. */
function inline(text: string, base: Omit<Span, "text"> = {}): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ ...base, text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ ...base, text: m[1], fg: palette.accent });
    else out.push({ ...base, text: m[2]!, bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) });
  return out;
}

export class MarkdownStreamer {
  private buf = "";
  private fence: { char: string; size: number } | null = null;
  private started = false; // something was emitted: blank lines may follow
  private blank = false; // a blank line is waiting for more text after it

  constructor(private readonly width: number) {}

  /** Complete lines produced by this chunk. */
  feed(chunk: string): Line[] {
    const parts = (this.buf + chunk).split("\n");
    this.buf = parts.pop() ?? "";
    const out: Line[] = [];
    for (const raw of parts) this.line(raw.replace(/\r$/, ""), out);
    return out;
  }

  /** The unfinished last line; ends an open code block. */
  flush(): Line[] {
    const out: Line[] = [];
    if (this.buf !== "") this.line(this.buf.replace(/\r$/, ""), out);
    this.buf = "";
    this.fence = null;
    this.blank = false;
    return out;
  }

  private emit(out: Line[], lines: Line[]): void {
    if (this.blank) out.push([]);
    this.blank = false;
    out.push(...lines);
    this.started = true;
  }

  private line(raw: string, out: Line[]): void {
    const text = sanitize(stripCR(raw));
    const fence = FENCE.exec(text);
    if (this.fence) {
      if (fence && fence[1]![0] === this.fence.char && fence[1]!.length >= this.fence.size && text.trim() === fence[1]) {
        this.fence = null;
        return;
      }
      this.emit(out, this.code(text));
      return;
    }
    if (fence) {
      this.fence = { char: fence[1]![0]!, size: fence[1]!.length };
      return;
    }
    if (text.trim() === "") {
      if (this.started) this.blank = true;
      return;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      this.emit(out, wrapSpans(inline(heading[1]!, { bold: true }), this.width));
      return;
    }
    const item = ITEM.exec(text);
    if (item) {
      const lead = `${item[1]}${item[2]} `;
      this.emit(out, wrapSpans([{ text: lead }, ...inline(item[3]!)], this.width, { indent: " ".repeat(displayWidth(lead)) }));
      return;
    }
    this.emit(out, wrapSpans(inline(text), this.width));
  }

  /** A code line behind the bar, cut (not word-wrapped) at the width. */
  private code(text: string): Line[] {
    const bar = (rest: string): Span[] => [{ text: rest ? `${G.bar} ` : G.bar, dim: true }];
    if (text === "") return [bar("")];
    const room = Math.max(1, this.width - 2);
    return splitAtWidth([{ text, dim: true }], room).map((row) => [...bar("x"), ...row]);
  }
}
