import { afterEach, describe, expect, test } from "bun:test";
import type { TrustStore } from "../session/trust";
import { mount, unmount, type Mounted } from "./test-utils";

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

function store(): TrustStore & { saved: string[] } {
  const saved: string[] = [];
  return { saved, trusted: () => false, trust: (d) => void saved.push(d) };
}

describe("the trust question in the footer", () => {
  test("it shows the folder and the two choices, in place of the input box", async () => {
    m = await mount({ trust: store() });
    const f = m.frame();
    expect(f).toContain("Do you trust the files in this folder?");
    expect(f).toContain("~/proj");
    expect(f).toContain("1. Yes, I trust this folder");
    expect(f).toContain("2. No, exit");
    expect(f).toContain("enter confirm");
    expect(f).not.toContain("shift+tab mode");
  });

  test("Enter takes the highlighted choice: yes, and the session starts", async () => {
    const t = store();
    m = await mount({ trust: t });
    m.setup.mockInput.pressEnter();
    await m.settle();
    expect(t.saved).toEqual(["/home/alex/proj"]);
    expect(m.c.getState().phase).toBe("idle");
    expect(m.frame()).not.toContain("Do you trust");
  });

  test("Down then Enter, 2, n and Esc all say no", async () => {
    for (const keys of [["down", "return"], ["2"], ["n"], ["escape"]]) {
      const t = store();
      m = await mount({ trust: t });
      for (const k of keys) {
        if (k === "down") m.setup.mockInput.pressArrow("down");
        else if (k === "return") m.setup.mockInput.pressEnter();
        else if (k === "escape") m.setup.mockInput.pressEscape();
        else m.setup.mockInput.pressKey(k);
        await m.settle();
      }
      expect(m.exits).toEqual(["exit"]);
      expect(t.saved).toEqual([]);
      unmount(m);
      m = undefined;
    }
  });

  test("1 and y say yes", async () => {
    for (const k of ["1", "y"]) {
      const t = store();
      m = await mount({ trust: t });
      m.setup.mockInput.pressKey(k);
      await m.settle();
      expect(t.saved).toEqual(["/home/alex/proj"]);
      unmount(m);
      m = undefined;
    }
  });

  test("a key typed the moment the question appears doesn't answer it", async () => {
    const t = store();
    m = await mount({ trust: t, guardMs: 500 });
    m.setup.mockInput.pressEnter();
    await m.settle();
    expect(t.saved).toEqual([]);
    m.clock.t += 600;
    m.setup.mockInput.pressEnter();
    await m.settle();
    expect(t.saved).toEqual(["/home/alex/proj"]);
  });
});
