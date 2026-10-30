import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mount, unmount, until, type Mounted } from "../footer/test-utils";
import { AppKeymapProvider } from "../hub/keymap/AppKeymap";
import { adaptBridge, BridgeProvider } from "../hub/state/BridgeContext";
import { activeTheme, applyTheme, THEMES } from "../hub/theme";
import { applyConfigAccent, codeSettingsPath, palette } from "../theme";
import { toSessionLike } from "./session-adapter";

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
  applyTheme();
  applyConfigAccent("/nonexistent/config.yaml");
});
beforeEach(() => rmSync(codeSettingsPath(), { force: true }));

const CFG = { ollama_api_url: "http://old:11434", project_dir: "", workdir: "/home/alex/launch", default_chat_model: "m", tools_enabled: true, memory_enabled: true, memory_auto: true, history_autosave: true };

/** A stateful config, as the engine keeps it. */
function engine(extra: Record<string, unknown> = {}) {
  let cfg: Record<string, unknown> = { ...CFG };
  return {
    "config.get": () => ({ ...cfg }),
    "config.set": (p: Record<string, unknown>) => (cfg = { ...cfg, ...(p.patch as object) }),
    "ollama.check": { ok: true, url: "http://new:11434", version: "0.40.2" },
    "models.installed": { models: [{ name: "m" }] },
    ...extra,
  };
}

function mountPanels(answers: Record<string, unknown> = {}, o: { width?: number; height?: number } = {}): Promise<Mounted> {
  const height = o.height ?? 36;
  return mount({
    width: o.width ?? 120,
    height,
    rows: height,
    answers,
    wrap: (footer, bridge) => (
      <AppKeymapProvider>
        <BridgeProvider client={adaptBridge(bridge)}>{footer}</BridgeProvider>
      </AppKeymapProvider>
    ),
  });
}
const noted = (mm: Mounted) => mm.sink.lines.join("\n");
const spansOf = (mm: Mounted) => mm.setup.captureSpans().lines.flatMap((l) => l.spans);
/** Spans with a background of our own (reverse video is the terminal's own colours swapped: not a paint). */
const painted = (mm: Mounted) => spansOf(mm).filter((s) => (s.bg as { a?: number } | undefined)?.a && !(s.attributes & TextAttributes.INVERSE));
const titled = (mm: Mounted, title: string) => mm.lines().some((l) => l.includes(`◆ ${title}`));

describe("/theme and the Theme window", () => {
  test("/theme nord is saved in aihub-code's own settings (not AIhub's config), applied, and the accent follows", async () => {
    m = await mountPanels(engine());
    const mm = m;
    const before = palette.accent;
    await mm.c.runCommand("theme", "nord");
    expect(JSON.parse(readFileSync(codeSettingsPath(), "utf8")).theme).toBe("nord");
    expect(activeTheme.name).toBe("nord");
    expect(palette.accent).toBe(THEMES.nord!.palette.accent as string);
    expect(palette.accent).not.toBe(before);
    expect(palette.green).toBe(THEMES.nord!.palette.success as string);
    expect(palette.red).toBe(THEMES.nord!.palette.error as string);
    expect(palette.yellow).toBe(THEMES.nord!.palette.warn as string);
    expect(mm.bridge.to("config.set")).toHaveLength(0);
    expect(noted(mm)).toContain("Theme → Nord");
  });

  test("/theme terminal restores the default: the terminal's own colours, no background painted", async () => {
    m = await mountPanels(engine());
    const mm = m;
    await mm.c.runCommand("theme", "nord");
    mm.c.openPanel("help");
    await until(() => titled(mm, "Help"), mm.settle);
    expect(painted(mm).length).toBeGreaterThan(0); // nord paints its surfaces
    mm.setup.mockInput.pressEscape();
    await until(() => mm.c.getState().panel === null, mm.settle);

    await mm.c.runCommand("theme", "terminal");
    expect(JSON.parse(readFileSync(codeSettingsPath(), "utf8")).theme).toBe("terminal");
    expect(palette.green).toBe("ansi:2");
    mm.c.openPanel("help");
    await until(() => titled(mm, "Help"), mm.settle);
    expect(painted(mm)).toEqual([]);
  });

  test("an unknown theme says which there are, and changes nothing", async () => {
    m = await mountPanels(engine());
    await m.c.runCommand("theme", "neon");
    expect(noted(m)).toContain("No theme named neon");
    expect(noted(m)).toContain("terminal");
    expect(activeTheme.name).toBe("terminal");
    expect(existsSync(codeSettingsPath())).toBe(false);
  });

  test("the Theme window's Enter writes the same place (and the accent, which AIhub shares, to its config)", async () => {
    m = await mountPanels(engine());
    const mm = m;
    mm.c.openPanel("theme");
    await until(() => titled(mm, "Theme"), mm.settle);
    mm.setup.mockInput.pressArrow("down"); // terminal -> aihub
    mm.setup.mockInput.pressArrow("down"); // -> tokyo-night
    await mm.settle();
    mm.setup.mockInput.pressEnter();
    await until(() => mm.c.getState().panel === null, mm.settle);
    expect(JSON.parse(readFileSync(codeSettingsPath(), "utf8")).theme).toBe("tokyo-night");
    expect(palette.accent).toBe(THEMES["tokyo-night"]!.palette.accent as string);
    expect(mm.bridge.to("config.set").map((c) => (c.params.patch as Record<string, unknown>).theme)).toEqual([undefined]);
    expect(mm.bridge.to("config.set")[0]!.params.patch).toEqual({ accent: "" });
    expect(noted(mm)).toContain("Theme → Tokyo Night");
  });

  test("Esc in the Theme window puts the old theme back and saves nothing", async () => {
    m = await mountPanels(engine());
    const mm = m;
    mm.c.openPanel("theme");
    await until(() => titled(mm, "Theme"), mm.settle);
    mm.setup.mockInput.pressArrow("down");
    await mm.settle();
    expect(activeTheme.name).not.toBe("terminal");
    mm.setup.mockInput.pressEscape();
    await until(() => mm.c.getState().panel === null, mm.settle);
    expect(activeTheme.name).toBe("terminal");
    expect(existsSync(codeSettingsPath())).toBe(false);
  });
});

describe("Settings", () => {
  const openSettings = async (mm: Mounted) => {
    mm.c.openPanel("settings");
    await until(() => titled(mm, "Settings") && mm.frame().includes("http://old:11434"), mm.settle).catch((e) => {
      throw new Error(`${e.message}\n${mm.frame()}`);
    });
  };

  test("changing the Ollama URL asks the new server for its models and says when the current one isn't there", async () => {
    m = await mountPanels(engine());
    const mm = m;
    mm.bridge.answers["models.installed"] = { models: [{ name: "x" }, { name: "y" }] }; // the new server's
    await openSettings(mm);
    const asked = mm.bridge.to("models.installed").length;
    mm.setup.mockInput.pressTab();
    await mm.settle();
    for (let i = 0; i < "http://old:11434".length; i++) mm.setup.mockInput.pressBackspace();
    await mm.setup.mockInput.typeText("http://new:11434");
    mm.setup.mockInput.pressEnter();
    await until(() => mm.bridge.to("models.installed").length > asked, mm.settle);
    await until(() => noted(mm).includes("isn't on this Ollama server"), mm.settle);
    expect(noted(mm)).toContain("m isn't on this Ollama server — /models lists its 2 models.");
  });

  test("the working directory is this folder, read-only: it is not a field and is never saved", async () => {
    m = await mountPanels(engine());
    const mm = m;
    await openSettings(mm);
    expect(mm.frame()).toContain("/home/alex/proj (this folder)");
    mm.setup.mockInput.pressEnter(); // save
    await until(() => mm.bridge.to("config.set").length > 0, mm.settle);
    expect(mm.bridge.to("config.set")[0]!.params.patch).not.toHaveProperty("project_dir");
    // Tab walks the fields without stopping on it: server, GPU memory, model, memory model.
    for (const f of ["Ollama server", "Ollama GPU memory", "Default model", "Memory model"]) {
      mm.setup.mockInput.pressTab();
      await mm.settle();
      const row = mm.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes(f));
      expect(row && (row.attributes & TextAttributes.INVERSE) !== 0, `${f} focused`).toBe(true);
    }
  });

  test("a focused field is visible without a background: its label is reverse video (terminal theme)", async () => {
    m = await mountPanels(engine());
    const mm = m;
    await openSettings(mm);
    const label = () => spansOf(mm).find((s) => s.text.includes("Ollama server"))!;
    expect((label().attributes & TextAttributes.INVERSE) !== 0).toBe(false);
    mm.setup.mockInput.pressTab();
    await mm.settle();
    expect((label().attributes & TextAttributes.INVERSE) !== 0).toBe(true);
  });

  test("the memory and tools switches are the controller's state: read from config, kept in step, used by the next chat turn", async () => {
    m = await mountPanels(engine({ "config.get": () => ({ ...CFG, tools_enabled: false, memory_enabled: false }), "config.set": (p: any) => ({ ...CFG, ...p.patch }), "chat.start": { messages: [] } }));
    const mm = m;
    expect(mm.c.getState().toolsEnabled).toBe(false);
    expect(mm.c.getState().memoryEnabled).toBe(false);
    expect(toSessionLike(mm.c.getState()).toolsEnabled).toBe(false);
    expect(toSessionLike(mm.c.getState()).memoryEnabled).toBe(false);
    await mm.c.setKind({ type: "chat" });
    mm.c.openPanel("settings");
    await until(() => titled(mm, "Settings"), mm.settle);
    await until(() => /Tool calling\s+\[ \]/.test(mm.frame()) || mm.frame().includes("Tool calling"), mm.settle);
    mm.setup.mockInput.pressKey("t");
    await until(() => mm.c.getState().toolsEnabled, mm.settle);
    mm.setup.mockInput.pressKey("m");
    await until(() => mm.c.getState().memoryEnabled, mm.settle);
    mm.setup.mockInput.pressEscape();
    await until(() => mm.c.getState().panel === null, mm.settle);
    mm.c.submit("hi");
    await mm.settle();
    expect(mm.bridge.to("chat.turn").at(-1)!.params.tools_enabled).toBe(true);
  });

  test("a context set by hand applies to a chat at once (the window's number is what the turn runs with)", async () => {
    m = await mountPanels(engine({ "chat.start": { messages: [] } }));
    const mm = m;
    await mm.c.setKind({ type: "chat" });
    mm.c.patchSession({ contextLength: 16384, ctxMax: 16384 });
    expect(mm.c.getState().ctx.limit).toBe(16384);
    mm.c.submit("hi");
    await mm.settle();
    expect(mm.bridge.to("chat.turn").at(-1)!.params.context_length).toBe(16384);
  });

  test("under the code agent a context set by hand applies to the next session: it says so", async () => {
    m = await mountPanels(engine());
    const mm = m;
    const before = mm.c.getState().ctx.limit;
    mm.c.patchSession({ contextLength: 16384, ctxMax: 16384 });
    expect(mm.c.getState().ctx.limit).toBe(before);
    expect(noted(mm)).toContain("next session");
  });
});
