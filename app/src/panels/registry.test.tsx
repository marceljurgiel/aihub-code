import { afterEach, describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { launch, type Launched } from "../app";
import type { Args } from "../args";
import { mount, sleep, unmount, until, type Mounted } from "../footer/test-utils";
import { AppKeymapProvider } from "../hub/keymap/AppKeymap";
import { VIEW_ONLY } from "../hub/modals/ModelPickerModal";
import { adaptBridge, BridgeProvider } from "../hub/state/BridgeContext";
import { MockBridge } from "../session/mock-bridge";
import type { PanelId } from "../session/controller";
import { PANEL_IDS, panelFactory } from "./registry";

const TITLES: Record<PanelId, string> = {
  memory: "Memory",
  models: "Models",
  hardware: "Hardware",
  agents: "Agents",
  skills: "Skills",
  mcp: "Connections",
  knowledge: "Knowledge",
  schedule: "Schedule",
  missed: "Missed task",
  history: "History",
  settings: "Settings",
  theme: "Theme",
  temperature: "Temperature",
  palette: "Command palette",
  help: "Help",
};

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

/** The footer inside the providers app.tsx puts around it. */
function mountPanels(o: { width?: number; height?: number; answers?: Record<string, unknown> } = {}): Promise<Mounted> {
  const height = o.height ?? 36;
  return mount({
    width: o.width ?? 120,
    height,
    rows: height,
    answers: o.answers,
    wrap: (footer, bridge) => (
      <AppKeymapProvider>
        <BridgeProvider client={adaptBridge(bridge)}>{footer}</BridgeProvider>
      </AppKeymapProvider>
    ),
  });
}

const promptShown = (mm: Mounted) => mm.lines().some((l) => /^\s*│\s*>/.test(l));
const noted = (mm: Mounted) => mm.sink.lines.join("\n");
/** The panel's title bar: `◆ <title> … esc close`. */
const titled = (mm: Mounted, title: string) => mm.lines().some((l) => l.includes(`◆ ${title}`) && l.includes("esc close"));

describe("the panel registry", () => {
  test("every PanelId has a factory", () => {
    expect([...PANEL_IDS].sort()).toEqual((Object.keys(TITLES) as PanelId[]).sort());
    for (const id of PANEL_IDS) expect(typeof panelFactory(id, { controller: {} as never, session: {} as never })).toBe("function");
  });

  for (const id of Object.keys(TITLES) as PanelId[]) {
    test(`${id}: opens above the prompt under a bridge that answers {} to everything, Esc closes it`, async () => {
      m = await mountPanels();
      const mm = m;
      expect(mm.c.openPanel(id)).toBe(true);
      await until(() => titled(mm, TITLES[id]), mm.settle);
      expect(promptShown(mm)).toBe(false);
      // Some windows go back a level on Esc first (a focused filter); a few presses close any.
      for (let i = 0; i < 4 && mm.c.getState().panel; i++) {
        mm.setup.mockInput.pressEscape();
        await mm.settle();
      }
      await until(() => promptShown(mm), mm.settle);
      expect(mm.c.getState().panel).toBeNull();
    });
  }
});

describe("panels and a running turn (Review Focus 1)", () => {
  test("a panel command while a turn runs is refused with the note", async () => {
    m = await mountPanels();
    const mm = m;
    mm.c.submit("do it");
    await mm.settle();
    expect(mm.c.getState().phase).toBe("running");
    for (const id of PANEL_IDS.filter((p) => p !== "models")) {
      expect(mm.c.openPanel(id)).toBe(false);
    }
    expect(mm.c.getState().panel).toBeNull();
    expect(noted(mm)).toContain("Finish or interrupt the current turn first (Esc).");
  });

  test("/models while a turn runs opens view-only: picking does nothing but say so", async () => {
    m = await mountPanels({ answers: { "models.installed": { models: [{ name: "m" }, { name: "qwen2.5-coder:7b" }] } } });
    const mm = m;
    mm.c.submit("do it");
    await mm.settle();
    expect(mm.c.openPanel("models")).toBe(true);
    expect(mm.c.getState().panel).toEqual({ id: "models", viewOnly: true });
    await until(() => mm.frame().includes("qwen2.5-coder:7b"), mm.settle);
    expect(mm.frame()).toContain(VIEW_ONLY);
    mm.setup.mockInput.pressArrow("down");
    mm.setup.mockInput.pressEnter();
    await mm.settle();
    expect(mm.bridge.to("code.start")).toHaveLength(1); // the start-up one only
    expect(mm.c.getState().panel?.id).toBe("models");
    expect(mm.frame()).toContain(VIEW_ONLY);
  });

  test("the permission prompt comes first: keys never reach a panel under it", async () => {
    m = await mountPanels();
    const mm = m;
    mm.c.submit("do it");
    await mm.settle();
    mm.c.openPanel("models");
    await until(() => titled(mm, "Models"), mm.settle);
    mm.bridge.lastStream.emit("permission_request", {
      name: "edit_file", arguments: { path: "calc.py" }, diff: null, suggested_rule: null, mode: "build", reason: "edit", permission_id: 1,
    });
    await until(() => !titled(mm, "Models"), mm.settle);
    // A key that would type into the models filter answers the prompt instead (or nothing).
    mm.setup.mockInput.pressEscape();
    await mm.settle();
    expect(mm.c.getState().panel?.id).toBe("models");
  });
});

describe("an unreachable engine (Review Focus 3)", () => {
  for (const id of ["history", "hardware"] as PanelId[]) {
    test(`${id}: the panel shows the failure, Esc closes it, the next prompt starts a turn`, async () => {
      m = await mountPanels();
      const mm = m;
      mm.bridge.request = (method: string, params: Record<string, unknown> = {}) => {
        mm.bridge.calls.push({ method, params });
        return Promise.reject(new Error("connection refused"));
      };
      mm.c.openPanel(id);
      await until(() => mm.frame().includes("connection refused"), mm.settle);
      mm.setup.mockInput.pressEscape();
      await until(() => promptShown(mm), mm.settle);
      mm.c.submit("still there?");
      await mm.settle();
      expect(mm.bridge.to("code.turn")).toHaveLength(1);
      expect(mm.c.getState().phase).toBe("running");
    });
  }
});

describe("keys in a panel", () => {
  test("Ctrl+P at the prompt opens the palette; Enter on Models opens the models panel", async () => {
    m = await mountPanels();
    const mm = m;
    mm.setup.mockInput.pressKey("p", { ctrl: true });
    await until(() => titled(mm, "Command palette"), mm.settle);
    await mm.setup.mockInput.typeText("models");
    await mm.settle();
    mm.setup.mockInput.pressEnter();
    await until(() => titled(mm, "Models"), mm.settle);
    expect(mm.c.getState().panel?.id).toBe("models");
  });

  test("Ctrl+C does what the window's Esc does: an unsaved memory asks first", async () => {
    m = await mountPanels({ answers: { "memory.load": { content: "## Editor\nAlex uses Helix.\n" } } });
    const mm = m;
    mm.c.openPanel("memory");
    await until(() => mm.frame().includes("Alex uses Helix."), mm.settle);
    await mm.setup.mockInput.typeText("Z");
    await until(() => mm.frame().includes("unsaved"), mm.settle);
    mm.setup.mockInput.pressKey("c", { ctrl: true });
    await until(() => mm.frame().includes("Esc again to discard"), mm.settle);
    expect(mm.c.getState().panel).not.toBeNull();
    mm.setup.mockInput.pressKey("c", { ctrl: true });
    await until(() => promptShown(mm), mm.settle);
    expect(mm.exits).toEqual([]); // closing a window never exits the app
  });
});

describe("the panel's size", () => {
  test("a window lays out for the panel's width, not its own (Help at 120 columns)", async () => {
    m = await mountPanels({ width: 120 });
    const mm = m;
    mm.c.openPanel("help");
    await until(() => titled(mm, "Help"), mm.settle);
    // AIhub's 78-column card cuts this to 20 cells; the 120-column panel has room.
    expect(mm.frame()).toContain("Save a fact → /memory save <key> <value>");
    expect(mm.frame()).toContain("/undo");
    expect(mm.frame()).toContain("S-Tab");
  });
});

describe("the terminal theme (ruling R-T3-1)", () => {
  test("the selected row and the keycaps show without a background: reverse video", async () => {
    m = await mountPanels();
    const mm = m;
    mm.c.openPanel("palette");
    await until(() => titled(mm, "Command palette"), mm.settle);
    const spans = mm.setup.captureSpans().lines.flatMap((l) => l.spans);
    const inverse = (s: { attributes: number }) => (s.attributes & TextAttributes.INVERSE) !== 0;
    const first = spans.find((s) => s.text.includes("New Chat"))!;
    const second = spans.find((s) => s.text.includes("Agent"))!;
    expect(inverse(first)).toBe(true);
    expect(inverse(second)).toBe(false);
    // The hint bar's keycaps: ` ↑↓ ` and ` enter `.
    expect(inverse(spans.find((s) => s.text === " enter ")!)).toBe(true);
    // Moving the selection moves the reverse video.
    mm.setup.mockInput.pressArrow("down");
    await mm.settle();
    const after = mm.setup.captureSpans().lines.flatMap((l) => l.spans);
    expect(inverse(after.find((s) => s.text.includes("New Chat"))!)).toBe(false);
    expect(inverse(after.find((s) => s.text.includes("Agent"))!)).toBe(true);
  });
});

describe("a resize while a panel is open (Review Focus 2)", () => {
  const ARGS: Args = { cont: false, mcp: [], kb: [] };
  let open: { setup: Awaited<ReturnType<typeof createTestRenderer>>; app: Launched } | undefined;
  afterEach(() => {
    open?.setup.renderer.destroy();
    open = undefined;
  });

  test("120×36 → 100×30: the panel fits 100 columns; after Esc the transcript is written once", async () => {
    const setup = await createTestRenderer({
      width: 120,
      height: 36,
      screenMode: "split-footer",
      footerHeight: 5,
      externalOutputMode: "capture-stdout",
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
    const resets: unknown[] = [];
    setup.renderer.resetSplitFooterForReplay = (opts) => {
      resets.push(opts ?? {});
      setup.externalOutput.clear();
    };
    const bridge = new (class extends MockBridge {
      destroy() {}
    })();
    bridge.answers["config.get"] = { default_chat_model: "m" };
    bridge.answers["code.start"] = { session_id: "s1", project: { root: "/home/alex/proj", is_git: true }, mode: "build", model: "m", context_length: 1000 };
    bridge.answers["models.installed"] = { models: [{ name: "m" }] };
    const app = launch({ renderer: setup.renderer, bridge, args: ARGS, cwd: "/home/alex/proj", home: "/home/alex", resizeQuietMs: 30 });
    open = { setup, app };
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await sleep(15);
        await setup.renderOnce();
      }
    };
    const lines = () => setup.captureCharFrame().split("\n").map((l) => l.trimEnd());
    await settle();
    app.controller.openPanel("help");
    await until(() => lines().some((l) => l.includes("◆ Help")), settle);
    setup.resize(100, 30);
    await until(() => setup.renderer.footerHeight === 29, settle);
    const frame = lines();
    expect(frame.some((l) => l.includes("◆ Help"))).toBe(true);
    expect(Math.max(...frame.map((l) => l.length))).toBeLessThanOrEqual(100);
    // The title bar's "esc close" sits at the right edge of the 100 columns.
    expect(frame.find((l) => l.includes("◆ Help"))!.trimEnd().endsWith("esc close")).toBe(true);
    await sleep(80);
    await settle();
    expect(resets).toEqual([]);
    setup.mockInput.pressEscape();
    await until(() => resets.length > 0, settle);
    await sleep(80);
    await settle();
    expect(resets).toEqual([{ clearSavedLines: true }]);
    expect(setup.renderer.footerHeight).toBe(5);
  });
});

describe("kinds from the windows (Task 5)", () => {
  const AGENTS = {
    agents: [
      { name: "reviewer", description: "Reviews code", prompt: "", tools: ["read_file"], permission: "ask", model: "", context: 0, builtin: true, path: "" },
    ],
    dir: "/x",
  };

  test("agents: Enter on Plain chat switches to chat; p on a profile starts it in plan", async () => {
    m = await mountPanels({
      answers: {
        "agents.list": AGENTS,
        "chat.start": { messages: [{ role: "system", content: "s" }] },
        "agent.check": { ok: true, context: 4096, agent: AGENTS.agents[0] },
      },
    });
    const mm = m;
    mm.c.submit("/agent");
    await until(() => mm.frame().includes("reviewer"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.c.getState().kind.type === "chat", mm.settle);
    expect(mm.c.getState().panel).toBeNull();
    expect(mm.bridge.to("chat.start")).toHaveLength(1);

    mm.c.submit("/agents");
    await until(() => mm.frame().includes("reviewer"), mm.settle);
    mm.setup.mockInput.pressArrow("down");
    await mm.settle();
    mm.setup.mockInput.pressKey("p");
    await until(() => mm.c.getState().kind.type === "agent", mm.settle);
    expect(mm.c.getState().kind).toEqual({ type: "agent", name: "reviewer", submode: "plan" });
    expect(mm.bridge.to("agent.check")[0]!.params).toMatchObject({ agent: "reviewer" });
  });

  test("history: Enter loads the conversation into chat; the next prompt continues it", async () => {
    const saved = [
      { role: "system", content: "s" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ];
    m = await mountPanels({
      answers: {
        "history.list": { sessions: [{ filename: "a.json", start_time: "2026-10-01T10:00:00", message_count: 2 }] },
        "history.load": { messages: saved, start_time: "2026-10-01T10:00:00" },
      },
    });
    const mm = m;
    mm.c.submit("/history");
    await until(() => mm.frame().includes("2026-10-01 10:00"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.c.getState().kind.type === "chat", mm.settle);
    expect(noted(mm)).toContain("Resumed session — 2 messages.");
    await until(() => mm.c.getState().panel === null && mm.c.getState().phase === "idle", mm.settle);
    mm.c.submit("and now?");
    await mm.settle();
    expect(mm.bridge.lastStream.method).toBe("chat.turn");
    expect(mm.bridge.lastStream.params.messages).toEqual([...saved, { role: "user", content: "and now?" }]);
  });
});
