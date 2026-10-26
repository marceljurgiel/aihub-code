/**
 * The transcript goes into the terminal's own scrollback; only the footer is
 * redrawn. `ScrollbackSink` is the seam: the app writes lines to a sink, the
 * real one commits them through OpenTUI's split-footer renderer, the test one
 * records them. `Transcript` keeps every written line in memory so a resize
 * (which leaves ghost rows behind) can reset the footer and write it all again.
 */
import {
  RGBA,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import { lineText, sanitize, wrapSpans } from "./width";

export type Span = { text: string; fg?: string; bold?: boolean; dim?: boolean };
export type Line = Span[];

/** Text that arrives in pieces (a model reply). */
export interface StreamSurface {
  /** Lines (and, in the real sink, finished rows) are committed as they complete. */
  append(text: string): void;
  /** Commits the unfinished rest. */
  end(): void;
}

export interface ScrollbackSink {
  write(lines: Line[]): void;
  stream(): StreamSurface;
}

// ── Transcript store ──────────────────────────────────────────────────────────

export class Transcript {
  private lines: Line[] = [];
  private replaying = false;

  /** `maxLines` bounds memory in a very long session: the oldest lines go. */
  constructor(private readonly maxLines = 20000) {}

  add(lines: Line[]): void {
    if (this.replaying) return; // a replay re-writes what is stored already
    this.lines.push(...lines);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }

  all(): Line[] {
    return [...this.lines];
  }

  /** Write everything again, in order, through `sink`. */
  replay(sink: Pick<ScrollbackSink, "write">): void {
    this.replaying = true;
    try {
      sink.write(this.all());
    } finally {
      this.replaying = false;
    }
  }
}

/** Splits streamed text into logical lines; the part after the last newline waits. */
function takeLines(buf: string, text: string): { lines: string[]; rest: string } {
  const parts = (buf + text).split("\n");
  return { rest: parts.pop() ?? "", lines: parts };
}

// ── Test sink ─────────────────────────────────────────────────────────────────

export interface MemorySink extends ScrollbackSink {
  /** Everything written, as plain strings. */
  readonly lines: string[];
  /** The same with styles. */
  readonly styled: Line[];
}

export function memorySink(transcript?: Transcript): MemorySink {
  const styled: Line[] = [];
  const lines: string[] = [];
  const put = (ls: Line[]) => {
    for (const l of ls) {
      styled.push(l);
      lines.push(lineText(l));
    }
  };
  return {
    lines,
    styled,
    write(ls) {
      put(ls);
      transcript?.add(ls);
    },
    stream() {
      let buf = "";
      let ended = false;
      const commit = (text: string) => {
        const l: Line = [{ text }];
        put([l]);
        transcript?.add([l]);
      };
      return {
        append(text) {
          if (ended) return;
          const t = takeLines(buf, text);
          buf = t.rest;
          t.lines.forEach(commit);
        },
        end() {
          if (ended) return;
          ended = true;
          if (buf !== "") commit(buf);
          buf = "";
        },
      };
    },
  };
}

// ── Real sink (OpenTUI split-footer) ──────────────────────────────────────────

/** What the sink needs of the renderer; a `CliRenderer` in split-footer mode. */
export type ScrollbackRenderer = Pick<CliRenderer, "width" | "createScrollbackSurface" | "resetSplitFooterForReplay"> & {
  readonly isDestroyed?: boolean;
};

const ROWS_PER_COMMIT = 500;

export function colour(fg: string | undefined): RGBA {
  if (!fg) return RGBA.defaultForeground(); // the terminal's own text colour
  if (fg.startsWith("ansi:")) return RGBA.fromIndex(Number(fg.slice(5)));
  return RGBA.fromHex(fg);
}

export function spanChunk(span: Span): TextChunk {
  const attributes = (span.bold ? TextAttributes.BOLD : 0) | (span.dim ? TextAttributes.DIM : 0);
  return { __isChunk: true, text: span.text, fg: colour(span.fg), ...(attributes ? { attributes } : {}) };
}

const cleanLine = (line: Line): Line => line.map((s) => ({ ...s, text: sanitize(s.text).replace(/\n/g, " ") }));

/** Rows exactly as the terminal will show them: no row is wider than `width`.
 * Formatted lines already fit; a replay at a narrower width (or a long line
 * stored whole) wraps at spaces, and breaks only a word longer than a row. */
function rowsOf(lines: Line[], width: number): Line[] {
  return lines.flatMap((l) => wrapSpans(l, width));
}

/** Commit rows (each at most one terminal row wide) to the scrollback. */
function commitRows(renderer: ScrollbackRenderer, rows: Line[]): void {
  // A signal destroys the renderer before the app has closed: the last notes
  // ("interrupted") have no terminal left to go to.
  if (renderer.isDestroyed) return;
  for (let i = 0; i < rows.length; i += ROWS_PER_COMMIT) {
    const surface = renderer.createScrollbackSurface();
    try {
      for (const row of rows.slice(i, i + ROWS_PER_COMMIT)) {
        surface.root.add(
          new TextRenderable(surface.renderContext, {
            content: row.length ? new StyledText(row.map(spanChunk)) : "",
            wrapMode: "none",
            flexShrink: 0,
          }),
        );
      }
      surface.render();
      surface.commitRows(0, surface.height);
    } finally {
      surface.destroy();
    }
  }
}

export interface RendererSink extends ScrollbackSink {
  /** After a resize: reset the footer's ghost rows and write the whole
   * transcript again at the current width. Streams in flight carry on. */
  replay(options?: { clearSavedLines?: boolean }): void;
}

export function rendererSink(renderer: ScrollbackRenderer, transcript: Transcript): RendererSink {
  const raw = (lines: Line[]) => commitRows(renderer, rowsOf(lines, renderer.width));
  const active = new Set<RendererStream>();

  class RendererStream implements StreamSurface {
    private buf = "";
    private committed = 0; // rows of the unfinished line already in the scrollback
    private ended = false;

    private wrapped(text: string): Line[] {
      return wrapSpans([{ text: sanitize(text).replace(/\n/g, " ") }], renderer.width);
    }

    /** A line is complete: its remaining rows go out, and it is stored whole
     * (a replay wraps it again at whatever width it finds then). */
    private finish(text: string): void {
      raw(this.wrapped(text).slice(this.committed));
      this.committed = 0;
      transcript.add([[{ text: sanitize(text) }]]);
    }

    /** Word wrap only ever changes the last row, so the rows before it are final. */
    commitStable(): void {
      const rows = this.wrapped(this.buf);
      const stable = rows.length - 1;
      if (stable > this.committed) {
        raw(rows.slice(this.committed, stable));
        this.committed = stable;
      }
    }

    /** The scrollback was cleared: the unfinished line starts over. */
    rewind(): void {
      this.committed = 0;
      this.commitStable();
    }

    append(text: string): void {
      if (this.ended) return;
      const t = takeLines(this.buf, text);
      this.buf = t.rest;
      // Finishing a line that was unfinished before this chunk: the buffer
      // before the first newline still counts its rows from `committed`.
      for (const line of t.lines) this.finish(line);
      this.commitStable();
    }

    end(): void {
      if (this.ended) return;
      this.ended = true;
      active.delete(this);
      if (this.buf !== "") this.finish(this.buf);
      this.buf = "";
    }
  }

  return {
    write(lines) {
      const clean = lines.map(cleanLine);
      transcript.add(clean);
      raw(clean);
    },
    stream() {
      const s = new RendererStream();
      active.add(s);
      return s;
    },
    replay(options) {
      renderer.resetSplitFooterForReplay(options);
      transcript.replay({ write: raw });
      for (const s of active) s.rewind();
    },
  };
}
