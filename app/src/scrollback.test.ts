import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextAttributes } from "@opentui/core";
import {
  Transcript,
  memorySink,
  rendererSink,
  spanChunk,
  type Line,
  type ScrollbackRenderer,
} from "./scrollback";
import { palette } from "./theme";

const L = (text: string): Line => [{ text }];
const plain = (lines: Line[]) => lines.map((l) => l.map((s) => s.text).join(""));

describe("memorySink", () => {
  test("write records the lines as plain strings", () => {
    const sink = memorySink();
    sink.write([L("one"), [{ text: "tw", bold: true }, { text: "o", fg: "#ff0000" }]]);
    expect(sink.lines).toEqual(["one", "two"]);
    expect(sink.styled[1]![0]!.bold).toBe(true);
  });

  test("a stream commits a line when its newline arrives, the rest on end()", () => {
    const sink = memorySink();
    const s = sink.stream();
    s.append("a\nb");
    expect(sink.lines).toEqual(["a"]);
    s.end();
    expect(sink.lines).toEqual(["a", "b"]);
  });

  test("chunks may split a line anywhere", () => {
    const sink = memorySink();
    const s = sink.stream();
    s.append("he");
    s.append("llo\nwor");
    expect(sink.lines).toEqual(["hello"]);
    s.append("ld\n\nlast");
    expect(sink.lines).toEqual(["hello", "world", ""]);
    s.end();
    expect(sink.lines).toEqual(["hello", "world", "", "last"]);
  });

  test("a trailing newline leaves nothing to commit at end(); end() twice is harmless", () => {
    const sink = memorySink();
    const s = sink.stream();
    s.append("a\n");
    s.end();
    s.end();
    s.append("late");
    s.end();
    expect(sink.lines).toEqual(["a"]);
  });

  test("a recording sink feeds the transcript, streamed lines included", () => {
    const t = new Transcript();
    const sink = memorySink(t);
    sink.write([L("first")]);
    const s = sink.stream();
    s.append("x\ny");
    s.end();
    expect(plain(t.all())).toEqual(["first", "x", "y"]);
  });
});

describe("Transcript", () => {
  test("replay writes everything again, in order", () => {
    const t = new Transcript();
    t.add([L("a"), L("b")]);
    t.add([L("c")]);
    const sink = memorySink();
    t.replay(sink);
    expect(sink.lines).toEqual(["a", "b", "c"]);
  });

  test("replaying into a recording sink does not record twice", () => {
    const t = new Transcript();
    const sink = memorySink(t);
    sink.write([L("a")]);
    t.replay(sink);
    t.replay(sink);
    expect(plain(t.all())).toEqual(["a"]);
    expect(sink.lines).toEqual(["a", "a", "a"]);
  });

  test("all() is a copy; the oldest lines go first when the cap is hit", () => {
    const t = new Transcript(3);
    t.add([L("1"), L("2")]);
    t.add([L("3"), L("4")]);
    expect(plain(t.all())).toEqual(["2", "3", "4"]);
    t.all().pop();
    expect(t.all()).toHaveLength(3);
  });
});

describe("spanChunk", () => {
  test("no colour means the terminal's own foreground", () => {
    expect(spanChunk({ text: "x" }).fg!.intent).toBe("default");
  });
  test("hex colours, terminal palette slots, bold and dim", () => {
    expect(spanChunk({ text: "x", fg: "#a855f7" }).fg!.intent).toBe("rgb");
    const red = spanChunk({ text: "x", fg: palette.red });
    expect(red.fg!.intent).toBe("indexed");
    expect(red.fg!.slot).toBe(1);
    const a = spanChunk({ text: "x", bold: true, dim: true }).attributes!;
    expect(a & TextAttributes.BOLD).toBeTruthy();
    expect(a & TextAttributes.DIM).toBeTruthy();
    expect(spanChunk({ text: "x" }).attributes ?? 0).toBe(0);
  });
});

// The real renderer in split-footer mode, headless: commits are captured.
const setups: Awaited<ReturnType<typeof createTestRenderer>>[] = [];
async function harness(width = 30) {
  const setup = await createTestRenderer({
    width,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 2,
    externalOutputMode: "capture-stdout",
  });
  setups.push(setup);
  const resets: unknown[] = [];
  const renderer: ScrollbackRenderer = {
    get width() {
      return setup.renderer.width;
    },
    createScrollbackSurface: (o) => setup.renderer.createScrollbackSurface(o),
    // The headless renderer has no terminal to clear; what matters is that
    // the sink asks, and that everything it writes afterwards is complete.
    resetSplitFooterForReplay: (o) => {
      resets.push(o ?? {});
      setup.externalOutput.clear();
    },
  };
  const transcript = new Transcript();
  const sink = rendererSink(renderer, transcript);
  const out = async () => {
    await setup.flush();
    return setup.externalOutput.take().flatMap((c) => c.rows.map((r) => r.trimEnd()));
  };
  return { setup, sink, transcript, out, resets };
}
afterEach(() => {
  while (setups.length) setups.pop()!.renderer.destroy();
});

describe("rendererSink (OpenTUI split-footer)", () => {
  test("write puts the lines into the scrollback", async () => {
    const h = await harness();
    h.sink.write([L("> hello"), [], L("last")]);
    expect(await h.out()).toEqual(["> hello", "", "last"]);
    expect(plain(h.transcript.all())).toEqual(["> hello", "", "last"]);
  });

  test("wide characters take their two cells", async () => {
    const h = await harness();
    h.sink.write([L("日本語 ok")]);
    expect(await h.out()).toEqual(["日本語 ok"]);
  });

  test("a line wider than the terminal is broken, not clipped", async () => {
    const h = await harness(10);
    h.sink.write([L("abcdefghijklmnopqrstuvwxyz")]);
    expect(await h.out()).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    expect(h.transcript.all()).toHaveLength(1);
  });

  test("a replay at a narrower width breaks lines at words", async () => {
    const h = await harness(24);
    h.sink.write([L("one two three four five")]);
    await h.out();
    h.setup.resize(12, 10);
    h.sink.replay();
    expect(await h.out()).toEqual(["one two", "three four", "five"]);
  });

  test("escape sequences from tool output never reach the terminal", async () => {
    const h = await harness();
    h.sink.write([L("a\x1b[31mred\x1b[0m\x07b")]);
    expect(await h.out()).toEqual(["aredb"]);
  });

  test("a stream commits finished rows as they fill and the rest at end()", async () => {
    const h = await harness(10);
    const s = h.sink.stream();
    s.append("alpha ");
    expect(await h.out()).toEqual([]); // one row so far, still growing
    s.append("beta gamma");
    expect(await h.out()).toEqual(["alpha beta"]); // "gamma" may still grow
    s.append(" delta\nnext");
    expect(await h.out()).toEqual(["gamma", "delta"]);
    s.end();
    expect(await h.out()).toEqual(["next"]);
    expect(plain(h.transcript.all())).toEqual(["alpha beta gamma delta", "next"]);
  });

  test("replay writes the transcript again after a reset", async () => {
    const h = await harness();
    h.sink.write([L("one"), L("two")]);
    await h.out();
    h.sink.replay();
    expect(h.resets).toHaveLength(1);
    expect(await h.out()).toEqual(["one", "two"]);
    expect(plain(h.transcript.all())).toEqual(["one", "two"]);
  });

  test("replay mid-stream loses and duplicates nothing", async () => {
    const h = await harness(10);
    h.sink.write([L("before")]);
    const s = h.sink.stream();
    s.append("done line\nalpha beta gamma");
    await h.out();
    h.sink.replay({ clearSavedLines: true });
    expect(h.resets).toEqual([{ clearSavedLines: true }]);
    s.append(" delta\n");
    s.end();
    expect(await h.out()).toEqual(["before", "done line", "alpha beta", "gamma", "delta"]);
    expect(plain(h.transcript.all())).toEqual(["before", "done line", "alpha beta gamma delta"]);
  });

  test("replay uses the new width", async () => {
    const h = await harness(20);
    h.sink.write([L("abcdefghijklmnopqrst")]);
    await h.out();
    h.setup.resize(8, 10);
    h.sink.replay();
    expect(await h.out()).toEqual(["abcdefgh", "ijklmnop", "qrst"]);
  });
});
