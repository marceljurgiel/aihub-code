import { afterEach, describe, expect, test } from "bun:test";
import { mount, unmount, type Mounted } from "./test-utils";

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});
const TIP = "/undo puts back the files the last turn changed.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the Did you know? line above the prompt", () => {
  test("it shows under an idle session, above the input box", async () => {
    m = await mount({ tip: TIP, tipTypeMs: 0 });
    const rows = m.lines();
    const at = rows.findIndex((r) => r.includes("Did you know?"));
    expect(rows[at]).toBe(` Did you know? ${TIP}`);
    expect(rows[at + 1]).toContain("╭");
  });

  test("it types itself out, quickly", async () => {
    m = await mount({ tip: TIP, tipTypeMs: 40 });
    const early = m.lines().find((r) => r.includes("Did you know?"))!;
    expect(early.length).toBeLessThan(` Did you know? ${TIP}`.length);
    await sleep(40 * TIP.length + 300);
    await m.settle();
    expect(m.frame()).toContain(` Did you know? ${TIP}`);
  });

  test("the first prompt sent takes it away for good", async () => {
    m = await mount({ tip: TIP, tipTypeMs: 0 });
    await m.setup.mockInput.typeText("hello");
    m.setup.mockInput.pressEnter();
    await m.settle();
    m.bridge.lastStream?.finish({});
    await m.settle();
    expect(m.frame()).not.toContain("Did you know?");
  });

  test("not while the model picker is open", async () => {
    m = await mount({ tip: TIP, tipTypeMs: 0, answers: { "config.get": {} } });
    expect(m.c.getState().phase).toBe("picker");
    expect(m.frame()).not.toContain("Did you know?");
  });
});
