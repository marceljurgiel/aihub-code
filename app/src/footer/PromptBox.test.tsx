import { afterEach, describe, expect, test } from "bun:test";
import { INFO, mount, sleep, unmount, until, type Mounted } from "./test-utils";

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

const A1 = { id: "a1", name: "x.png", width: 4, height: 4, kb: 1 };
const type = async (n: Mounted, s: string) => {
  await n.setup.mockInput.typeText(s);
  await n.settle();
};
const enter = async (n: Mounted) => {
  n.setup.mockInput.pressEnter();
  await n.settle();
};
const turns = (n: Mounted) => n.bridge.calls.filter((c) => c.method === "code.turn" || c.method === "chat.turn");
const answers = { "attach.paste": { attachments: [A1] }, "vision.check": { vision: true } };

describe("images in the prompt", () => {
  test("a typed image path attaches on Enter: a chip, no turn", async () => {
    m = await mount({ answers });
    await type(m, "/tmp/x.png");
    await enter(m);
    expect(m.frame()).toContain("[image x.png]");
    expect(turns(m)).toHaveLength(0);
    expect(m.submitted).toEqual([]);
    expect(m.bridge.calls.find((c) => c.method === "attach.paste")?.params).toEqual({ text: "/tmp/x.png" });
    expect(m.setup.captureCharFrame()).not.toContain("/tmp/x.png");
  });

  test("the next prompt sends images:[id] and clears the chips", async () => {
    m = await mount({ answers });
    await type(m, "/tmp/x.png");
    await enter(m);
    await type(m, "what is this");
    await enter(m);
    const t = turns(m);
    expect(t).toHaveLength(1);
    expect(t[0]!.method).toBe("code.turn");
    expect(t[0]!.params).toEqual({ text: "what is this", images: ["a1"] });
    expect(m.frame()).not.toContain("[image x.png]");
    expect(m.sink.lines.join("\n")).toContain("[image x.png]"); // the echo names it
    m.bridge.lastStream.finish({});
    await m.settle();
    await type(m, "and now");
    await enter(m);
    expect(turns(m)[1]!.params).toEqual({ text: "and now" });
  });

  test("a model that can't see: an error line, nothing attached", async () => {
    m = await mount({ answers: { ...answers, "vision.check": { vision: false } } });
    await type(m, "/tmp/x.png");
    await enter(m);
    expect(m.sink.lines.join("\n")).toContain("m can't see images");
    expect(m.frame()).not.toContain("[image");
    expect(m.bridge.calls.some((c) => c.method === "attach.paste")).toBe(false);
  });

  test("a no from vision.check is not remembered: the next try asks again", async () => {
    let said = false;
    m = await mount({ answers: { ...answers, "vision.check": () => ({ vision: said }) } });
    await type(m, "/tmp/x.png");
    await enter(m);
    expect(m.frame()).not.toContain("[image");
    said = true;
    await type(m, "/tmp/x.png");
    await enter(m);
    expect(m.frame()).toContain("[image x.png]");
  });

  test("a path that isn't an image file is sent as typed", async () => {
    m = await mount({ answers: { ...answers, "attach.paste": { attachments: [] } } });
    await type(m, "~/x.png");
    await enter(m);
    const n = m;
    await until(() => turns(n).length === 1, () => n.settle());
    expect(turns(m)[0]!.params).toEqual({ text: "~/x.png" });
  });

  test("ordinary text is never looked at by attach.paste", async () => {
    m = await mount({ answers });
    await type(m, "fix the bug in /tmp/x.py");
    await enter(m);
    expect(m.bridge.calls.some((c) => c.method === "attach.paste")).toBe(false);
    expect(turns(m)[0]!.params).toEqual({ text: "fix the bug in /tmp/x.py" });
  });

  test("a pasted image path attaches; other pastes land in the text", async () => {
    m = await mount({ answers });
    await m.setup.mockInput.pasteBracketedText("/tmp/x.png");
    await sleep(30);
    await m.settle();
    expect(m.frame()).toContain("[image x.png]");
    expect(m.frame()).not.toContain("/tmp/x.png");
    await m.setup.mockInput.pasteBracketedText("one\ntwo");
    await m.settle();
    expect(m.frame()).toContain("one");
    expect(m.frame()).toContain("two");
  });

  test("a pasted path that attach.paste refuses is inserted as text", async () => {
    m = await mount({ answers: { ...answers, "attach.paste": { attachments: [] } } });
    await m.setup.mockInput.pasteBracketedText("/tmp/gone.png");
    await sleep(30);
    await m.settle();
    expect(m.frame()).toContain("/tmp/gone.png");
    expect(m.frame()).not.toContain("[image");
  });

  test("Ctrl+V with an image in the clipboard attaches it", async () => {
    m = await mount({
      answers: { ...answers, "attach.clipboard": { attachment: { ...A1, id: "c1", name: "clipboard.png" } } },
      hasImage: async () => true,
    });
    m.setup.mockInput.pressKey("v", { ctrl: true });
    await sleep(30);
    await m.settle();
    expect(m.frame()).toContain("[image clipboard.png]");
  });

  test("Ctrl+V with no image leaves the prompt alone", async () => {
    m = await mount({ answers });
    m.setup.mockInput.pressKey("v", { ctrl: true });
    await sleep(30);
    await m.settle();
    expect(m.bridge.calls.some((c) => c.method === "attach.clipboard")).toBe(false);
    expect(m.frame()).not.toContain("[image");
  });

  test("Backspace on an empty prompt removes the last chip; with text it edits", async () => {
    m = await mount({ answers });
    await type(m, "/tmp/x.png");
    await enter(m);
    await type(m, "ab");
    m.setup.mockInput.pressBackspace();
    await m.settle();
    expect(m.frame()).toContain("[image x.png]");
    m.setup.mockInput.pressBackspace();
    await m.settle();
    m.setup.mockInput.pressBackspace();
    await m.settle();
    expect(m.frame()).not.toContain("[image");
  });

  test("the chips take a row inside the box; the footer's height follows", async () => {
    m = await mount({ answers });
    const before = m.heights[m.heights.length - 1]!;
    await type(m, "/tmp/x.png");
    await enter(m);
    expect(m.heights[m.heights.length - 1]).toBe(before + 1);
    const lines = m.lines();
    const chip = lines.findIndex((l) => l.includes("[image x.png]"));
    expect(lines[chip - 1]).toMatch(/^╭/);
    expect(lines[chip + 1]).toMatch(/^│ >/);
  });

  test("under chat, the user message carries images:[id]", async () => {
    m = await mount({
      answers: {
        ...answers,
        "chat.start": { messages: [{ role: "system", content: "s" }] },
        "agent.check": { ok: true },
      },
    });
    await m.c.setKind({ type: "chat" });
    await m.settle();
    await type(m, "/tmp/x.png");
    await enter(m);
    await type(m, "describe");
    await enter(m);
    const t = m.bridge.calls.find((c) => c.method === "chat.turn")!;
    const msgs = t.params.messages as any[];
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "describe", images: ["a1"] });
  });

  test("/clear drops pending images", async () => {
    m = await mount({ answers: { ...answers, "code.start": INFO } });
    await type(m, "/tmp/x.png");
    await enter(m);
    expect(m.frame()).toContain("[image");
    await m.c.clear();
    await m.settle();
    expect(m.frame()).not.toContain("[image");
  });

  describe("images follow the prompt they were attached for", () => {
    const attach = async (n: Mounted, id: string) => {
      n.bridge.answers["attach.paste"] = { attachments: [{ ...A1, id, name: `${id}.png` }] };
      await type(n, "/tmp/x.png");
      await enter(n);
      await sleep(30);
      await n.settle();
    };
    const running = async () => {
      const n = await mount({ answers });
      n.c.submit("first");
      await n.settle();
      return n;
    };

    test("queue A, attach X, queue B: A has no images, B has [X]", async () => {
      m = await running();
      m.c.submit("A");
      await attach(m, "x1");
      m.c.submit("B");
      await m.settle();
      expect(m.frame()).not.toContain("[image");
      m.bridge.lastStream.finish({});
      await m.settle();
      expect(turns(m)[1]!.params).toEqual({ text: "A" });
      m.bridge.lastStream.finish({});
      await m.settle();
      expect(turns(m)[2]!.params).toEqual({ text: "B", images: ["x1"] });
    });

    test("attach X, queue A: A has [X] and the chips clear at queue time", async () => {
      m = await running();
      await attach(m, "x1");
      expect(m.frame()).toContain("[image x1.png]");
      m.c.submit("A");
      await m.settle();
      expect(m.frame()).not.toContain("[image");
      m.bridge.lastStream.finish({});
      await m.settle();
      expect(turns(m)[1]!.params).toEqual({ text: "A", images: ["x1"] });
    });

    test("an interrupt drops a queued prompt together with its images", async () => {
      m = await running();
      await attach(m, "x1");
      m.c.submit("A");
      m.c.cancel();
      await m.settle();
      m.bridge.lastStream.finish({ cancelled: true });
      await m.settle();
      expect(m.c.getState().queue).toEqual([]);
      m.c.submit("C");
      await m.settle();
      expect(turns(m).at(-1)!.params).toEqual({ text: "C" });
    });
  });
});
