// Ported from AIhub-TUI v1.5.0 app/src/settings.test.tsx.
// aihub-code: the window is opened as a panel opens it. Not ported: /cd (not in
// aihub-code), the catalog refresh at start-up and the chat note after a server
// switch (both ChatScreen's; the switch is checked at onEngineChanged here).
import { test, expect, afterEach } from "bun:test";
import { SettingsModal, type EngineChange } from "./modals/SettingsModal.tsx";
import { initialSession } from "./state/SessionContext.tsx";
import { MockBridge, openWindow, type Opened } from "./test-tree.tsx";

let setup: Opened["setup"] | undefined;
let engine: EngineChange[] = [];
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function until(pred: (f: string) => boolean, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await setup!.flush();
    const f = setup!.captureCharFrame();
    if (pred(f)) return f;
  }
  throw new Error("frame never matched:\n" + setup!.captureCharFrame());
}

/** Engine double for settings: records requests and plays a remote server. */
class SettingsBridge extends MockBridge {
  calls: Array<[string, any]> = [];
  cfg: any = {
    ollama_api_url: "", project_dir: "", workdir: "/home/me/launch",
    default_chat_model: "llama3.2:3b", default_context_length: 4096,
    tools_enabled: true, memory_enabled: true,
  };
  reachable = true;
  remoteModels = ["qwen3:8b", "gemma4:latest"];
  override async request(method: string, params: any = {}): Promise<any> {
    this.calls.push([method, params]);
    switch (method) {
      case "config.get":
        return { ...this.cfg };
      case "config.set":
        this.cfg = { ...this.cfg, ...params.patch };
        return { ...this.cfg };
      case "ollama.check":
        return this.reachable
          ? { ok: true, url: "http://192.0.2.10:11434", version: "0.30.7" }
          : { ok: false, url: "http://192.0.2.10:11434", error: "no answer within 4 s" };
      case "models.installed":
        return this.cfg.ollama_api_url
          ? { models: this.remoteModels.map((name) => ({ name, size_gb: 5 })), recent: [] }
          : super.request(method);
      case "workdir.set":
        if (params.path === "/nope") throw new Error("not a directory: /nope");
        return { workdir: params.path };
      default:
        return super.request(method);
    }
  }
  patches() {
    return this.calls.filter(([m]) => m === "config.set").map(([, p]) => p.patch);
  }
}

async function boot(bridge = new SettingsBridge()) {
  engine = [];
  const session = { ...initialSession(), modelName: "llama3.2:3b", streamModel: "llama3.2:3b" };
  const win = await openWindow(
    bridge,
    (close) => (
      <SettingsModal session={session} onPatchSession={() => {}} onEngineChanged={(c) => engine.push(c)} onClose={close} />
    ),
    { width: 110, height: 30 },
  );
  setup = win.setup;
  return { t: setup, bridge };
}

/** Press a key and let React apply the resulting focus/state change. */
async function press(key: string) {
  setup!.mockInput.pressKey(key);
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 25));
    await setup!.flush();
  }
}

async function openSettings(t: NonNullable<typeof setup>) {
  // Wait for config.get to land: keys pressed before that are (rightly) ignored.
  await until((f) => /Default model\s+llama3\.2:3b/.test(f));
}

test("settings saves a remote Ollama server after checking it", async () => {
  const { t, bridge } = await boot();
  await openSettings(t);
  await press("TAB");                      // → Ollama server field
  await t.mockInput.typeText("192.0.2.10");
  t.mockInput.pressEnter();                         // enter saves
  const frame = await until((f) => f.includes("Settings saved."));
  expect(frame).toContain("Ollama 0.30.7");
  expect(bridge.calls.some(([m, p]) => m === "ollama.check" && p.url === "192.0.2.10")).toBe(true);
  expect(bridge.patches().at(-1).ollama_api_url).toBe("192.0.2.10");
});

test("switching server tells the host the Ollama server changed", async () => {
  const { t } = await boot();
  await openSettings(t);
  await press("TAB");
  await t.mockInput.typeText("192.0.2.10");
  t.mockInput.pressEnter();
  await until((f) => f.includes("Settings saved."));
  expect(engine.at(-1)?.ollamaChanged).toBe(true);
});

test("an unreachable server is saved but clearly flagged", async () => {
  const bridge = new SettingsBridge();
  bridge.reachable = false;
  const { t } = await boot(bridge);
  await openSettings(t);
  await press("TAB");
  await t.mockInput.typeText("192.0.2.10");
  t.mockInput.pressEnter();
  const frame = await until((f) => f.includes("unreachable"));
  expect(frame).toContain("no answer");           // the reason wraps; it isn't cut off
  expect(frame).toContain("within 4 s");
});

test("letters typed into a field don't trigger shortcuts", async () => {
  const { t, bridge } = await boot();
  await openSettings(t);
  await press("TAB");
  await press("TAB");                      // → Ollama GPU memory
  await press("TAB");                      // → Working directory
  await t.mockInput.typeText("/tmp/test");          // contains t, m, s, c
  t.mockInput.pressEnter();
  await until((f) => f.includes("Settings saved."));
  const patch = bridge.patches().at(-1);
  expect(patch.project_dir).toBe("/tmp/test");
  expect(patch.tools_enabled).toBe(true);           // "t" didn't toggle
  expect(patch.memory_enabled).toBe(true);          // "m" didn't toggle
  expect(bridge.patches().length).toBe(1);          // "s" didn't save early
});

test("a rejected setting shows why it wasn't saved", async () => {
  const bridge = new SettingsBridge();
  const orig = bridge.request.bind(bridge);
  bridge.request = async (m: string, p: any = {}) =>
    m === "config.set" ? Promise.reject(new Error("not a directory: /nope")) : orig(m, p);
  const { t } = await boot(bridge);
  await openSettings(t);
  await press("TAB");
  await press("TAB");
  await press("TAB");
  await t.mockInput.typeText("/nope");
  t.mockInput.pressEnter();
  await until((f) => f.includes("Not saved: not a directory: /nope"));
});




test("toggling memory saves at once (key or click)", async () => {
  const bridge = new SettingsBridge();
  bridge.cfg.memory_enabled = false;
  const { t } = await boot(bridge);
  await openSettings(t);
  await press("m");
  await until((f) => f.includes("Memory on — saved."));
  expect(bridge.patches().at(-1)).toEqual({ memory_enabled: true });

  // …and by clicking the row.
  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => /Memory\s+\[/.test(l));
  await t.mockMouse.click(lines[y]!.indexOf("Memory") + 2, y);
  await until((f) => f.includes("Memory off — saved."));
  expect(bridge.patches().at(-1)).toEqual({ memory_enabled: false });
});

test("toggling tools saves at once", async () => {
  const { t, bridge } = await boot();
  await openSettings(t);
  await press("t");
  await until((f) => f.includes("Tool calling off — saved."));
  expect(bridge.patches().at(-1)).toEqual({ tools_enabled: false });
});

test("Enter saves even when no field is focused", async () => {
  const { t, bridge } = await boot();
  await openSettings(t);
  t.mockInput.pressEnter();
  await until((f) => f.includes("Settings saved."));
  expect(bridge.patches().length).toBe(1);
});

test("Ollama GPU memory: a number is saved, garbage is refused", async () => {
  const { t, bridge } = await boot();
  await openSettings(t);
  await press("TAB");
  await press("TAB");                      // → Ollama GPU memory
  await t.mockInput.typeText("lots");
  t.mockInput.pressEnter();
  await until((f) => f.includes("GPU memory must be a number"));
  expect(bridge.patches().length).toBe(0);
});

test("Ollama GPU memory accepts a number of GB", async () => {
  const { t, bridge } = await boot();
  await openSettings(t);
  await press("TAB");
  await press("TAB");
  await t.mockInput.typeText("12");
  t.mockInput.pressEnter();
  await until((f) => f.includes("Settings saved."));
  expect(bridge.patches().at(-1).ollama_gpu_memory_gb).toBe(12);
});

