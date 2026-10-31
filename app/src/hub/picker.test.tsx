// Ported from AIhub-TUI v1.5.0 app/src/picker.test.tsx.
// aihub-code: the picker is opened as a panel opens it — full width, with only
// top and bottom rules — so the frame checks look for those rules instead of
// AIhub's rounded corners. A pick goes to onPick (the chat's "Model → …" note
// was ChatScreen's).
import { test, expect, afterEach } from "bun:test";
import { MockBridge, openWindow, type Opened } from "./test-tree.tsx";
import { ModelPickerModal, catalogCells, tpsLabel, humanAge, targetHeader } from "./modals/ModelPickerModal.tsx";

let setup: Opened["setup"] | undefined;
let picks: Array<[string, string, string]> = [];
let win: Opened | undefined;

async function render(bridge: unknown, size: { width: number; height: number }) {
  picks = [];
  win = await openWindow(
    bridge,
    (close) => (
      <ModelPickerModal
        currentModel="llama3.2:3b"
        installedSet={new Set(["llama3.2:3b"])}
        onPick={(name, backend, stream) => picks.push([name, backend, stream])}
        onClose={close}
      />
    ),
    size,
  );
  setup = win.setup;
}
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function until(pred: (f: string) => boolean, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await setup!.flush();
    const f = setup!.captureCharFrame();
    if (pred(f)) return f;
  }
  throw new Error("frame never matched:\n" + setup!.captureCharFrame());
}

const TARGET = {
  where: "server", label: "server 192.0.2.10", vram_gb: 8, vram_basis: "learned",
  ram_gb: 0, bw_eff: 37.4, bw_basis: "measured", shared_memory: true,
};
const fitOf = (size: number, extra: any = {}) => ({
  fits: true, placement: "gpu", est_tps: 37.4 / size, need_gb: size + 0.6,
  basis: "estimated", score: 80, ...extra,
});
const FIT_MODELS = [
  { name: "qwen3.5:4b", size_gb: 3.4, capabilities: ["tools", "thinking"], updated: "2 weeks ago", fit: fitOf(3.4, { score: 91 }) },
  { name: "qwen3:8b", size_gb: 5.2, capabilities: ["tools"], updated: "6 months ago", fit: fitOf(5.2, { basis: "measured", est_tps: 7.2, score: 74 }) },
  { name: "a-model-with-a-really-long-name-that-must-be-cut:latest", size_gb: 1, capabilities: [], fit: fitOf(1, { score: 40 }) },
  { name: "llama3.3:70b", size_gb: 43, capabilities: ["tools"], fit: { fits: false, placement: "none", est_tps: 0, basis: "estimated", score: 0 } },
];

class PickerBridge extends MockBridge {
  calls: Array<[string, any]> = [];
  override async request(method: string, params: any = {}): Promise<any> {
    this.calls.push([method, params]);
    switch (method) {
      case "models.recommend":
        return { target: TARGET, catalog_age_s: 120, models: FIT_MODELS };
      case "ollama.library":
        return {
          target: TARGET, catalog_age_s: 30,
          models: [
            { name: "gemma4", description: "Google Gemma 4", capabilities: ["vision", "tools"], updated: "1 week ago",
              best: { name: "gemma4:e4b", size_gb: 9.6, fit: fitOf(9.6, { placement: "partial", score: 55 }) } },
            { name: "granite4.1", description: "IBM Granite", capabilities: ["tools"], updated: "3 days ago",
              best: { name: "granite4.1:8b", size_gb: 5.1, fit: fitOf(5.1) } },
          ],
        };
      case "cloud.models":
        return { models: [
          { name: "gpt-oss:20b-cloud", family: "gpt-oss", description: "OpenAI open-weight", status: "free" },
          { name: "kimi-k2.6:cloud", family: "kimi-k2.6", description: "Moonshot", status: "" },
          { name: "glm-4.7:cloud", family: "glm-4.7", description: "", status: "retired", installed: true },
        ] };
      case "cloud.probe":
        return { results: params.names.map((n: string) => ({ name: n, status: "paid" })) };
      case "hf.gguf":
        return {
          target: TARGET, catalog_age_s: 30,
          models: [{ name: "unsloth/Qwen3-8B-GGUF", size_gb: 4.8, description: "unsloth · 1,234 downloads/mo", fit: fitOf(4.8) }],
        };
      default:
        return super.request(method);
    }
  }
}

async function openPicker(size: { width: number; height: number }) {
  const bridge = new PickerBridge();
  await render(bridge, size);
  await until((f) => f.includes("Installed"));
  return bridge;
}

const rowsOf = (frame: string, names: string[]) =>
  frame.split("\n").filter((l) => names.some((n) => l.includes(n)));

for (const size of [{ width: 80, height: 24 }, { width: 110, height: 34 }]) {
  test(`fit tab: aligned columns, header inside the modal (${size.width}×${size.height})`, async () => {
    await openPicker(size);
    setup!.mockInput.pressKey("2");
    const f = await until((x) => x.includes("qwen3.5:4b") && x.includes("fit for"));
    expect(f).toContain("server 192.0.2.10");
    expect(f).toContain("catalog 2 min ago");
    const lines = rowsOf(f, ["qwen3.5:4b", "qwen3:8b", "a-model-with", "llama3.3:70b"]);
    expect(lines.length).toBe(4);
    // Speed / placement / score columns line up on every row.
    const col = (s: string) => lines.map((l) => l.indexOf(s));
    expect(new Set(lines.map((l) => l.search(/[█░]/))).size).toBe(1);
    expect(lines[0]).toContain("~11 t/s");
    expect(lines[1]).toContain("7.2 t/s✓");        // measured on this server
    expect(lines[3]).toContain("—");
    expect(new Set(col("GPU").slice(0, 3)).size).toBe(1);
    // The hint bar is still the last line of the modal, not overwritten.
    const all = f.split("\n");
    const hints = all.findIndex((l) => l.includes("select") && l.includes("tab"));
    expect(hints).toBeGreaterThan(all.findIndex((l) => l.includes("llama3.3:70b")));
    expect(all.every((l) => l.length <= size.width)).toBe(true);
  });
}

test("ollama tab lists the cached catalog without a search", async () => {
  const bridge = await openPicker({ width: 110, height: 34 });
  setup!.mockInput.pressKey("3");
  const f = await until((x) => x.includes("granite4.1:8b"));
  expect(f).toContain("gemma4:e4b");
  expect(f).toContain("part");
  expect(f).toContain("catalog just now");
  expect(bridge.calls).toContainEqual(["ollama.library", { query: "", limit: 60 }]);
});

test("hf tab lists popular trusted models without a search", async () => {
  const bridge = await openPicker({ width: 110, height: 34 });
  setup!.mockInput.pressKey("4");
  const f = await until((x) => x.includes("unsloth/Qwen3-8B-GGUF"));
  expect(f).toContain("~7.8 t/s");
  expect(bridge.calls).toContainEqual(["hf.gguf", { query: "", limit: 40 }]);
});

test("cell helpers", () => {
  expect(tpsLabel({ fits: true, est_tps: 23.4, basis: "estimated" })).toBe("~23 t/s");
  expect(tpsLabel({ fits: false, est_tps: 5, basis: "estimated" })).toBe("—");
  expect(humanAge(null)).toBe("not downloaded yet");
  expect(humanAge(3 * 86400)).toBe("3 d ago");
  expect(targetHeader(TARGET)).toBe("fit for server 192.0.2.10 · GPU ~8 GB learned · 37 GB/s measured");
  expect(catalogCells({ kind: "ollama", name: "gemma4", best: { name: "gemma4:e4b", size_gb: 9.6, fit: fitOf(9.6) } }).name).toBe("gemma4:e4b");
});

test("cloud tab: Ollama Cloud models with plan status; free ones are used directly", async () => {
  const bridge = await openPicker({ width: 110, height: 34 });
  setup!.mockInput.pressKey("5");
  let f = await until((x) => x.includes("gpt-oss:20b-cloud") && x.includes("kimi-k2.6:cloud") && x.includes("paid"));
  expect(f).toMatch(/gpt-oss:20b-cloud\s+ollama\s+free/);
  expect(f).toMatch(/glm-4.7:cloud\s+ollama\s+retired/);
  expect(bridge.calls).toContainEqual(["cloud.probe", { names: ["kimi-k2.6:cloud"] }]);  // only the unknown one
  // paid → explained, not picked
  setup!.mockInput.pressArrow("down");
  await new Promise((r) => setTimeout(r, 60));
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("isn't in Ollama's free cloud plan"));
  // free → picked through the Ollama backend, no download
  setup!.mockInput.pressArrow("up");
  await new Promise((r) => setTimeout(r, 60));
  setup!.mockInput.pressEnter();
  await until(() => picks.length > 0);
  expect(picks).toEqual([["gpt-oss:20b-cloud", "ollama", "gpt-oss:20b-cloud"]]);
  expect(win!.isOpen()).toBe(false);
  expect(bridge.calls.some(([m]) => m === "models.pull")).toBe(false);
});

test("installed rows show size, params, context and what the model can do", async () => {
  const bridge = new PickerBridge();
  const orig = bridge.request.bind(bridge);
  bridge.request = async (m: string, p: any = {}) =>
    m === "models.installed"
      ? { models: [
          { name: "qwen3.5:9b", size_gb: 6.1, cloud: false, status: "", capabilities: ["vision", "tools", "thinking"], max_context: 262144, params: "9.7B", quant: "Q4_K_M" },
          { name: "deepseek-coder:6.7b", size_gb: 3.6, cloud: false, status: "", capabilities: [], max_context: 16384, params: "7B", quant: "Q4_0" },
          { name: "nemotron-3-ultra:cloud", size_gb: 0, cloud: true, status: "free", capabilities: ["thinking", "tools"], max_context: 262144, params: "550B", quant: "" },
        ], recent: [] }
      : orig(m, p);
  await render(bridge, { width: 110, height: 34 });
  const f = await until((x) => x.includes("can do") && x.includes("nemotron-3-ultra:cloud"));
  expect(f).toMatch(/qwen3\.5:9b\s+6\.1 GB\s+9\.7B\s+256K\s+tools · thinking · vision/);
  expect(f).toMatch(/deepseek-coder:6\.7b\s+3\.6 GB\s+7B\s+16K\s+—/);
  expect(f).toMatch(/nemotron-3-ultra:cloud\s+cloud\s+550B\s+256K\s+free\s+tools · thinking/);
});

test("installed rows show where each local model runs and how fast, best fit first", async () => {
  const bridge = new PickerBridge();
  const orig = bridge.request.bind(bridge);
  const base = { status: "", quant: "", capabilities: ["tools"], max_context: 131072 };
  bridge.request = async (m: string, p: any = {}) =>
    m === "models.installed"
      ? { target: TARGET, recent: [], models: [
          { ...base, name: "glm-4.7:cloud", size_gb: 0, cloud: true, status: "retired", capabilities: [], params: "" },
          { ...base, name: "huge:70b", size_gb: 40, cloud: false, params: "70B", fit: { fits: false, placement: "none", est_tps: 0, basis: "estimated", score: 0 } },
          { ...base, name: "lfm2.5:8b", size_gb: 4.8, cloud: false, params: "8.5B", fit: fitOf(4.8, { placement: "partial", est_tps: 11.4, score: 55 }) },
          { ...base, name: "gemma4:cloud", size_gb: 0, cloud: true, status: "free", params: "33B" },
          { ...base, name: "llama3.2:3b", size_gb: 1.9, cloud: false, params: "3.2B", fit: fitOf(1.9, { basis: "measured", est_tps: 24, score: 70 }) },
          { ...base, name: "gemma3:1b", size_gb: 0.8, cloud: false, params: "1B", fit: fitOf(0.8, { est_tps: 62, score: 81 }) },
        ] }
      : orig(m, p);
  await render(bridge, { width: 110, height: 34 });
  const f = await until((x) => x.includes("speed") && x.includes("huge:70b"));
  expect(f).toMatch(/size\s+params\s+ctx\s+speed\s+where\s+can do/);
  expect(f).toMatch(/gemma3:1b\s+0\.8 GB\s+1B\s+128K\s+~62 t\/s\s+GPU\s+tools/);
  expect(f).toMatch(/llama3\.2:3b\s+1\.9 GB\s+3\.2B\s+128K\s+24 t\/s✓\s+GPU\s+tools/);
  expect(f).toMatch(/lfm2\.5:8b\s+4\.8 GB\s+8\.5B\s+128K\s+~11 t\/s\s+part\s+tools/);
  expect(f).toMatch(/huge:70b\s+40 GB\s+70B\s+128K\s+—\s+✗/);
  expect(f).toMatch(/gemma4:cloud\s+cloud\s+33B\s+128K\s+free\s+tools/);
  // Runs here (best score first), then usable cloud, then what doesn't fit, then retired.
  const order = ["gemma3:1b", "llama3.2:3b", "lfm2.5:8b", "gemma4:cloud", "huge:70b", "glm-4.7:cloud"];
  const at = order.map((n) => f.indexOf(n));
  expect(at.every((x) => x >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

test("a name longer than the name column is cut, so the columns stay aligned (84 columns)", async () => {
  const bridge = new PickerBridge();
  const orig = bridge.request.bind(bridge);
  const base = { cloud: false, status: "", quant: "", capabilities: ["tools"], max_context: 131072, params: "8B" };
  bridge.request = async (m: string, p: any = {}) =>
    m === "models.installed"
      ? { recent: [], models: [
          { ...base, name: "gemma-4-12b-it-q4_k_m:latest", size_gb: 6.6, fit: fitOf(6.6, { score: 60 }) },
          { ...base, name: "llama3.2:3b", size_gb: 1.9, fit: fitOf(1.9, { score: 50 }) },
        ] }
      : orig(m, p);
  await render(bridge, { width: 84, height: 30 });
  const f = await until((x) => x.includes("llama3.2:3b"));
  const rows = f.split("\n").filter((l) => / GB /.test(l));
  expect(rows.length).toBe(2);
  expect(new Set(rows.map((l) => l.indexOf(" GB "))).size).toBe(1);
  expect(rows[0]).toContain("…");
});

// Real installed lists: long tags, every capability, a retired cloud model.
const MANY_INSTALLED = [
  { name: "embeddinggemma:latest", size_gb: 0.6, capabilities: ["embedding"], max_context: 2048, params: "308M" },
  { name: "qwen3.5:9b", size_gb: 6.1, capabilities: ["vision", "tools", "thinking"], max_context: 262144, params: "9.7B" },
  { name: "llama3.2:3b", size_gb: 1.9, capabilities: ["tools"], max_context: 131072, params: "3.2B" },
  { name: "gemma-4-12b-it-q4_k_m:latest", size_gb: 6.6, capabilities: ["tools", "thinking"], max_context: 262144, params: "12B" },
  { name: "deepseek-coder:6.7b", size_gb: 3.6, capabilities: [], max_context: 16384, params: "7B" },
  { name: "lfm2.5:8b", size_gb: 4.8, capabilities: ["tools", "thinking"], max_context: 131072, params: "8.5B" },
  { name: "lfm2.5-thinking:1.2b", size_gb: 0.7, capabilities: ["tools", "thinking"], max_context: 131072, params: "1.2B" },
  { name: "qwen3:8b", size_gb: 4.9, capabilities: ["tools", "thinking"], max_context: 40960, params: "8.2B" },
  { name: "glm-4.7:cloud", size_gb: 0, cloud: true, status: "retired", capabilities: [], max_context: 0, params: "" },
  { name: "kimi-k2.5:cloud", size_gb: 0, cloud: true, status: "retired", capabilities: [], max_context: 0, params: "" },
  { name: "qwen2.5-coder:7b", size_gb: 4.4, capabilities: ["tools", "insert"], max_context: 32768, params: "7.6B" },
].map((m) => ({ cloud: false, status: "", quant: "", ...m }));

for (const size of [{ width: 80, height: 24 }, { width: 80, height: 18 }, { width: 90, height: 30 }]) {
  test(`installed tab in a small terminal: one line per model, all inside the window (${size.width}×${size.height})`, async () => {
    const bridge = new PickerBridge();
    const orig = bridge.request.bind(bridge);
    bridge.request = async (m: string, p: any = {}) =>
      m === "models.installed" ? { models: MANY_INSTALLED, recent: [] } : orig(m, p);
    await render(bridge, size);
    // The column header draws before the list arrives: wait for the models.
    const f = await until((x) => x.includes("can do") && x.includes("embeddinggemma"));
    const all = f.split("\n");
    expect(all.every((l) => l.length <= size.width)).toBe(true);
    // The panel's top and bottom rules (no corners in the footer).
    const top = all.findIndex((l) => l.includes("Models") && l.includes("esc close")) - 1;
    const bottom = all.findIndex((l, i) => i > top + 1 && /^─{20,}$/.test(l.trim()) && l.trim().length === l.length);
    expect(all[top]).toMatch(/^─+$/);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThan(top);
    // The hint bar is the last line inside the frame, whole.
    expect(all[bottom - 1]).toMatch(/↑↓\s+select/);
    // Nothing of the window spills below its frame.
    const below = all.slice(bottom + 1).join("\n");
    for (const m of MANY_INSTALLED) expect(below).not.toContain(m.name);
    expect(below).not.toMatch(/tools|thinking|retired/);
    // Each visible model sits on its own line, and no line starts with a stray badge.
    const inside = all.slice(top, bottom);
    for (const l of inside) expect(l).not.toMatch(/^\s*(tools|thinking|vision|retired)\b/);
    const shown = MANY_INSTALLED.filter((m) => inside.some((l) => l.includes(m.name)));
    expect(shown.length).toBeGreaterThanOrEqual(3);
    expect(inside.find((l) => l.includes("qwen3.5:9b"))).toContain("tools");
  });
}

test("a failed pull shows the whole reason, not one cut line", async () => {
  const reason = "granite4.1:8b needs a newer Ollama than the one on gpu-box.lan (it has 0.30.7) — update Ollama there, then pull again.";
  const bridge = new PickerBridge();
  bridge.stream = ((method: string) =>
    method === "download.ollama"
      ? { id: 7, done: Promise.reject(new Error(reason)) }
      : { id: 1, done: Promise.resolve({ messages: [] }) }) as any;
  await render(bridge, { width: 110, height: 34 });
  await until((f) => f.includes("Installed"));
  setup!.mockInput.pressKey("3");
  await until((x) => x.includes("granite4.1:8b"));
  setup!.mockInput.pressEnter();
  const f = await until((x) => x.includes("then pull again."));
  expect(f.replace(/\s*\n\s*/g, " ")).toContain("update Ollama there");
});
