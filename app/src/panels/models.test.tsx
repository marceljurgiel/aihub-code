import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { launch } from "../app";
import { mount, sleep, unmount, until, type Mounted } from "../footer/test-utils";
import { AppKeymapProvider } from "../hub/keymap/AppKeymap";
import { VIEW_ONLY } from "../hub/modals/ModelPickerModal";
import { adaptBridge, BridgeProvider } from "../hub/state/BridgeContext";
import { MockBridge } from "../session/mock-bridge";

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

function mountPanels(answers: Record<string, unknown> = {}): Promise<Mounted> {
  return mount({
    width: 120,
    height: 36,
    rows: 36,
    answers: {
      "code.start": (p: Record<string, unknown>) => ({
        session_id: "s2",
        project: { root: "/home/alex/proj", branch: "main", dirty_total: 0, instruction_file: null, is_git: true },
        mode: "build",
        model: p.model,
        rules: [],
        context_length: p.model === "llama3.2:3b" ? 24576 : 1000,
        backend: p.backend ?? "ollama",
        stream_model: p.stream_model ?? p.model,
        temperature: 0.7,
        checkpoints: { mode: "shadow", note: "" },
      }),
      "models.installed": { models: [{ name: "m" }, { name: "llama3.2:3b" }] },
      ...answers,
    },
    wrap: (footer, bridge: MockBridge) => (
      <AppKeymapProvider>
        <BridgeProvider client={adaptBridge(bridge)}>{footer}</BridgeProvider>
      </AppKeymapProvider>
    ),
  });
}

const promptShown = (mm: Mounted) => mm.lines().some((l) => /^\s*│\s*>/.test(l));
const noted = (mm: Mounted) => mm.sink.lines.join("\n");

describe("picking a model", () => {
  test("an installed model: useModel, the panel closes, the new-session divider is written", async () => {
    m = await mountPanels();
    const mm = m;
    mm.c.openPanel("models");
    await until(() => mm.frame().includes("llama3.2:3b"), mm.settle);
    mm.setup.mockInput.pressArrow("down");
    await mm.settle();
    mm.setup.mockInput.pressEnter();
    await until(() => mm.c.getState().model === "llama3.2:3b" && promptShown(mm), mm.settle);
    expect(mm.bridge.to("code.start").at(-1)!.params).toMatchObject({ model: "llama3.2:3b", backend: "ollama" });
    expect(mm.c.getState().panel).toBeNull();
    expect(noted(mm)).toContain("new session with llama3.2:3b");
    expect(mm.c.getState().ctx.limit).toBe(24576);
  });

  test("an API model on the Cloud tab: backend and stream model reach code.start", async () => {
    m = await mountPanels({
      "api.models": { models: [{ name: "gpt-x", url: "https://api.example/v1/gpt-x", key_ready: true, context_window: 131072 }] },
      "cloud.models": { models: [] },
    });
    const mm = m;
    mm.c.openPanel("models");
    await until(() => mm.frame().includes("Installed"), mm.settle);
    mm.setup.mockInput.pressKey("5");
    await until(() => mm.frame().includes("gpt-x"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.bridge.to("code.start").length === 2, mm.settle);
    expect(mm.bridge.to("code.start").at(-1)!.params).toMatchObject({ model: "gpt-x", backend: "api", stream_model: "https://api.example/v1/gpt-x" });
    await until(() => mm.c.getState().backend === "api", mm.settle);
    expect(mm.c.getState().streamModel).toBe("https://api.example/v1/gpt-x");
  });
});

describe("downloads (Review Focus 4)", () => {
  const FIT = {
    "models.recommend": {
      target: { where: "server", label: "server", vram_gb: 8, vram_basis: "learned", ram_gb: 0, bw_eff: 30, bw_basis: "measured" },
      models: [{ name: "smol:1b", size_gb: 1, capabilities: [], fit: { fits: true, placement: "gpu", est_tps: 30, need_gb: 1.6, basis: "estimated", score: 80 } }],
    },
  };

  test("a pull follows the progress events; Esc cancels the stream and the picker says so", async () => {
    m = await mountPanels(FIT);
    const mm = m;
    mm.c.openPanel("models");
    await until(() => mm.frame().includes("Installed"), mm.settle);
    mm.setup.mockInput.pressKey("2");
    await until(() => mm.frame().includes("smol:1b"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.bridge.to("download.ollama").length === 1, mm.settle);
    expect(mm.bridge.to("download.ollama")[0]!.params).toEqual({ name: "smol:1b" });
    const pull = mm.bridge.lastStream;
    pull.emit("progress", { status: "pulling abc", total: 200, completed: 100 });
    await until(() => mm.frame().includes("50%") && mm.frame().includes("pulling abc"), mm.settle);
    mm.setup.mockInput.pressEscape();
    await until(() => mm.frame().includes("Pull cancelled."), mm.settle);
    expect(mm.bridge.controls.filter((c) => c.method === "chat.cancel").map((c) => c.params)).toEqual([{ request_id: pull.id }]);
    // The bridge stays usable, and the panel is still the models window.
    expect(mm.c.getState().panel?.id).toBe("models");
    pull.finish({ cancelled: true });
    mm.setup.mockInput.pressEscape();
    await until(() => promptShown(mm), mm.settle);
    mm.c.submit("still there?");
    await mm.settle();
    expect(mm.bridge.to("code.turn")).toHaveLength(1);
  });

  test("a finished pull is announced and the installed list refreshes", async () => {
    m = await mountPanels(FIT);
    const mm = m;
    mm.c.openPanel("models");
    await until(() => mm.frame().includes("Installed"), mm.settle);
    mm.setup.mockInput.pressKey("2");
    await until(() => mm.frame().includes("smol:1b"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.bridge.to("download.ollama").length === 1, mm.settle);
    const before = mm.bridge.to("models.installed").length;
    mm.bridge.lastStream.finish({ name: "smol:1b" });
    await until(() => mm.frame().includes("Pulled smol:1b."), mm.settle);
    expect(mm.bridge.to("models.installed").length).toBeGreaterThan(before);
  });
});

describe("view-only (one source)", () => {
  test("the note goes when the turn is over and picking works again", async () => {
    m = await mountPanels();
    const mm = m;
    mm.c.submit("do it");
    await mm.settle();
    expect(mm.c.openPanel("models")).toBe(true);
    await until(() => mm.frame().includes("llama3.2:3b"), mm.settle);
    expect(mm.frame()).toContain(VIEW_ONLY);
    mm.bridge.lastStream.finish({ messages: [], cancelled: false });
    await until(() => !mm.frame().includes(VIEW_ONLY), mm.settle);
    expect(mm.c.getState().panel).toEqual({ id: "models" });
    mm.setup.mockInput.pressArrow("down");
    await mm.settle();
    mm.setup.mockInput.pressEnter();
    await until(() => mm.c.getState().model === "llama3.2:3b", mm.settle);
  });

  test("closing the view-only window brings the turn's output back (the panel-close replay)", async () => {
    const setup = await createTestRenderer({
      width: 120,
      height: 36,
      screenMode: "split-footer",
      footerHeight: 5,
      externalOutputMode: "capture-stdout",
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
    setup.renderer.resetSplitFooterForReplay = () => setup.externalOutput.clear();
    const bridge = new (class extends MockBridge {
      destroy() {}
    })();
    bridge.answers["config.get"] = { default_chat_model: "m" };
    bridge.answers["code.start"] = { session_id: "s1", project: { root: "/home/alex/proj", is_git: true }, mode: "build", model: "m", context_length: 1000 };
    bridge.answers["models.installed"] = { models: [{ name: "m" }, { name: "llama3.2:3b" }] };
    const app = launch({ renderer: setup.renderer, bridge, args: { cont: false, mcp: [], kb: [] }, cwd: "/home/alex/proj", home: "/home/alex", resizeQuietMs: 30 });
    try {
      const settle = async () => {
        for (let i = 0; i < 4; i++) {
          await sleep(15);
          await setup.renderOnce();
        }
      };
      const lines = () => setup.captureCharFrame().split("\n").map((l) => l.trimEnd());
      await settle();
      app.controller.submit("do it");
      await settle();
      expect(app.controller.openPanel("models")).toBe(true);
      await until(() => lines().some((l) => l.includes("llama3.2:3b")), settle);
      expect(lines().join("\n")).toContain(VIEW_ONLY);
      bridge.lastStream.emit("text", { text: "all done here\n" });
      await settle();
      setup.mockInput.pressEscape();
      await until(() => app.controller.getState().panel === null, settle);
      await settle();
      await sleep(80);
      await settle();
      const out = setup.externalOutput.take().flatMap((c) => c.rows.map((r) => r.trimEnd())).join("\n");
      expect(out).toContain("all done here");
      expect(out).toContain("> do it");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("hardware, temperature, context", () => {
  test("/hardware renders hardware.scan", async () => {
    m = await mountPanels({
      "hardware.scan": { os: "Linux 7", cpu: { model: "Ryzen 7 8845HS", cores_physical: 8, cores_logical: 16 }, ram: { total_gb: 32, available_gb: 20 }, disk: { total_gb: 500, free_gb: 200 }, gpu: { model: "Radeon 780M", vram_total_mb: 8192 } },
      "target.info": { where: "server", label: "server 192.0.2.10", vram_gb: 8, vram_basis: "learned", bw_eff: 30, bw_basis: "measured" },
    });
    const mm = m;
    await mm.c.runCommand("hardware", "");
    await until(() => mm.frame().includes("Ryzen 7 8845HS") && mm.frame().includes("server 192.0.2.10"), mm.settle);
    expect(mm.frame()).toContain("Radeon 780M");
  });

  test("the Temperature window saves through setTemperature", async () => {
    m = await mountPanels({ "config.set": {} });
    const mm = m;
    mm.c.openPanel("temperature");
    await until(() => mm.frame().includes("Temperature"), mm.settle);
    mm.setup.mockInput.pressKey("1"); // a preset
    await until(() => mm.bridge.to("config.set").length === 1, mm.settle);
    const t = (mm.bridge.to("config.set")[0]!.params as any).patch.temperature;
    expect(typeof t).toBe("number");
    await until(() => noted(mm).includes(`Temperature → ${t.toFixed(1)}.`), mm.settle);
    expect(mm.c.getState().temperature).toBe(t);
  });

  test("Settings → c sets a model's context; the next code.start reports it", async () => {
    m = await mountPanels({ "context.set": { manual: 24576, model: "m" }, "hardware.recommend_context": { context: 8192, fits: 8192, manual: 0 } });
    const mm = m;
    mm.c.openPanel("settings");
    await until(() => mm.frame().includes("Settings"), mm.settle);
    mm.setup.mockInput.pressKey("c");
    await until(() => mm.frame().includes("Context"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.bridge.to("context.set").length === 1, mm.settle);
    expect(mm.bridge.to("context.set")[0]!.params).toMatchObject({ model: "m" });
    for (let i = 0; i < 4 && mm.c.getState().panel; i++) {
      mm.setup.mockInput.pressEscape();
      await mm.settle();
    }
    await mm.c.useModel({ name: "llama3.2:3b", backend: "ollama" });
    expect(mm.c.getState().ctx.limit).toBe(24576); // what the engine's code.start answered
  });
});
