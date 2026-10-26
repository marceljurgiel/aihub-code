import { afterEach, describe, expect, test } from "bun:test";
import { IDLE_FOOTER_ROWS } from "../app";
import { mount, unmount, until, type Mounted } from "../footer/test-utils";
import { AppKeymapProvider } from "../hub/keymap/AppKeymap";
import { adaptBridge, BridgeProvider } from "../hub/state/BridgeContext";

const FACTS = "## Editor\nAlex uses Helix.\n\n## Servers\nThe GPU box is gpu-box.lan.\n";
const ROWS = 30;

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

/** The footer inside the providers app.tsx puts around it, with memory.load answering. */
function mountWithPanel(): Promise<Mounted> {
  return mount({
    height: ROWS,
    rows: ROWS,
    answers: { "memory.load": { content: FACTS } },
    wrap: (footer, bridge) => (
      <AppKeymapProvider>
        <BridgeProvider client={adaptBridge(bridge)}>{footer}</BridgeProvider>
      </AppKeymapProvider>
    ),
  });
}
const noted = (mm: Mounted) => mm.sink.lines.join("\n");

const promptShown = (mm: Mounted) => mm.lines().some((l) => /^\s*│\s*>/.test(l));

describe("PanelHost: AIhub's memory window in the footer", () => {
  test("openPanel shows the facts in place of the prompt box; Esc brings the prompt back", async () => {
    m = await mountWithPanel();
    const mm = m;
    expect(promptShown(mm)).toBe(true);

    expect(mm.c.openPanel("memory")).toBe(true);
    await until(() => mm.frame().includes("Alex uses Helix."), mm.settle);
    const open = mm.frame();
    expect(open).toContain("Memory");
    expect(open).toContain("The GPU box is gpu-box.lan.");
    expect(promptShown(mm)).toBe(false);
    expect(mm.bridge.to("memory.load")).toHaveLength(1);
    expect(mm.heights.at(-1)).toBe(ROWS - 1);

    mm.setup.mockInput.pressEscape();
    await until(() => promptShown(mm), mm.settle);
    expect(mm.c.getState().panel).toBeNull();
    expect(mm.frame()).not.toContain("Alex uses Helix.");
    expect(mm.heights.at(-1)).toBe(IDLE_FOOTER_ROWS);
  });

  test("keys go to the panel only: the footer's own Esc / typing never act meanwhile", async () => {
    m = await mountWithPanel();
    const mm = m;
    mm.c.openPanel("memory");
    await until(() => mm.frame().includes("Alex uses Helix."), mm.settle);
    // Typing lands in the memory editor (it is a text editor), not the prompt.
    mm.setup.mockInput.pressArrow("down");
    await mm.setup.mockInput.typeText("Z");
    await until(() => mm.frame().includes("unsaved"), mm.settle);
    // An edited memory asks before discarding: the first Esc only warns.
    mm.setup.mockInput.pressEscape();
    await until(() => mm.frame().includes("Esc again to discard"), mm.settle);
    expect(mm.c.getState().panel).not.toBeNull();
    mm.setup.mockInput.pressEscape();
    await until(() => promptShown(mm), mm.settle);
    // Nothing typed in the panel reached the prompt box.
    expect(mm.frame()).not.toMatch(/>\s*Z/);
    expect(mm.bridge.to("memory.save")).toHaveLength(0);
  });

  test("Esc in the panel interrupts nothing and the prompt answers keys again after", async () => {
    m = await mountWithPanel();
    const mm = m;
    mm.c.openPanel("memory");
    await until(() => mm.frame().includes("Alex uses Helix."), mm.settle);
    mm.setup.mockInput.pressEscape();
    await until(() => promptShown(mm), mm.settle);
    await mm.setup.mockInput.typeText("hello");
    await until(() => mm.frame().includes("> hello"), mm.settle);
    expect(mm.bridge.controls.filter((c) => c.method === "chat.cancel")).toHaveLength(0);
  });
});

describe("Controller.openPanel / closePanel", () => {
  test("refused while a turn runs, with a note", async () => {
    m = await mountWithPanel();
    const mm = m;
    mm.c.submit("do it");
    await mm.settle();
    expect(mm.c.getState().phase).toBe("running");
    expect(mm.c.openPanel("memory")).toBe(false);
    expect(mm.c.getState().panel).toBeNull();
    expect(noted(mm)).toContain("Finish or interrupt the current turn first (Esc).");
  });

  test("closePanel writes a non-empty result as a note", async () => {
    m = await mountWithPanel();
    const mm = m;
    mm.c.openPanel("memory", "x");
    expect(mm.c.getState().panel).toEqual({ id: "memory", arg: "x" });
    mm.c.closePanel("Memory saved.");
    expect(mm.c.getState().panel).toBeNull();
    expect(noted(mm)).toContain("Memory saved.");
  });
});
