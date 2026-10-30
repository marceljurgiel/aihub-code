// Ported from AIhub-TUI v1.5.0 app/src/modals/SettingsModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { singleLinePaste } from "../clipboard.ts";
import { theme, fit, flatTheme, lift } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { useModals } from "../state/ModalContext.tsx";
import { ModalShell, useShellHeight, useShellWidth } from "../ui/ModalShell.tsx";
import { SectionLabel } from "../ui/primitives.tsx";
import { useModalKeys } from "./modalKit.ts";
import { TemperatureModal, temperatureLabel } from "./TemperatureModal.tsx";
import type { SessionState } from "../state/SessionContext.tsx";

function ToggleRow({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <box onMouseDown={onToggle}>
      <text>
        <span fg={theme.fg2}>{`  ${label.padEnd(19)}`}</span>
        <span fg={value ? theme.success : theme.fg2}>{value ? "[✓] on " : "[ ] off"}</span>
      </text>
    </box>
  );
}

/** One-line labelled text field. Click or Tab to focus. */
function FieldRow({
  label,
  value,
  placeholder,
  focused,
  onFocus,
  onInput,
  onSubmit,
}: {
  label: string;
  value: string;
  placeholder: string;
  focused: boolean;
  onFocus: () => void;
  onInput: (v: string) => void;
  /** Enter: receives the field's current text straight from the input. */
  onSubmit: (value: string) => void;
}) {
  // Updated on every keystroke, so Enter right after a paste sees the text
  // even before the parent's state has re-rendered.
  const latest = useRef(value);
  latest.current = value;
  return (
    // Fixed-size row: a long value must scroll inside the field, not widen it
    // (a pasted URL used to squeeze the label and push the rows below down).
    <box flexDirection="row" height={1} flexShrink={0} onMouseDown={onFocus}>
      {/* aihub-code: under the see-through terminal theme bg3 shows nothing, so
          the focused field's label is reverse video (lift). */}
      <text flexShrink={0} fg={focused ? (flatTheme() ? theme.fg0 : theme.accent) : theme.fg2} attributes={lift(focused)}>{`  ${label.padEnd(18)}`}</text>
      <box
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        height={1}
        overflow="hidden"
        marginRight={2}
        paddingLeft={1}
        backgroundColor={focused ? theme.bg3 : theme.bg2}
      >
        <input
          width="100%"
          onPaste={singleLinePaste}
          value={value}
          focused={focused}
          onInput={(v: string) => {
            latest.current = v;
            onInput(v);
          }}
          onSubmit={() => onSubmit(latest.current)}
          placeholder={placeholder}
          backgroundColor={focused ? theme.bg3 : theme.bg2}
          focusedBackgroundColor={theme.bg3}
          textColor={theme.fg0}
          placeholderColor={theme.fg2}
          cursorColor={theme.accent}
        />
      </box>
    </box>
  );
}

type FieldId = "ollama" | "gpuMem" | "workdir" | "model" | "memoryModel";
const FIELDS: FieldId[] = ["ollama", "gpuMem", "workdir", "model", "memoryModel"];

/** On/off settings that save the moment they're flipped. */
type SwitchId = "tools" | "memory" | "autoLearn" | "autosave";
const SWITCHES: Record<SwitchId, { label: string; key: string; config: string; session?: "toolsEnabled" | "memoryEnabled" }> = {
  tools: { label: "Tool calling", key: "t", config: "tools_enabled", session: "toolsEnabled" },
  memory: { label: "Memory", key: "m", config: "memory_enabled", session: "memoryEnabled" },
  autoLearn: { label: "Auto-learn", key: "a", config: "memory_auto" },
  autosave: { label: "Autosave chats", key: "h", config: "history_autosave" },
};

export type EngineChange = {
  /** Effective tools working directory after the save. */
  workdir: string;
  /** The Ollama server address changed — models/status must be re-read. */
  ollamaChanged: boolean;
};

/** Engine settings (config.get / config.set) plus a context-size editor that
 *  consults hardware.recommend_context. */
export function SettingsModal({
  session,
  onPatchSession,
  onEngineChanged,
  onTemperature,
  fixedWorkdir,
  onClose,
}: {
  session: SessionState;
  onPatchSession: (patch: Partial<SessionState>) => void;
  onEngineChanged?: (change: EngineChange) => void;
  /** Applies and saves a new temperature (the same path as /temp). */
  onTemperature?: (t: number) => void;
  /** aihub-code: the folder the tools work in is the one it was started in
   *  (no /cd): shown read-only, never a field, never saved. */
  fixedWorkdir?: string;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const modals = useModals();
  const [cfg, setCfg] = useState<any>(null);
  const [ollama, setOllama] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [model, setModel] = useState("");
  // The current model's context: set by hand (manual) or automatic.
  const [ctxInfo, setCtxInfo] = useState<{ context: number; manual: boolean } | null>(null);
  const [memoryModel, setMemoryModel] = useState("");
  const [temperature, setTemperatureShown] = useState(session.temperature);
  // GPU memory of the machine running Ollama; empty = learned from chats.
  const [gpuMem, setGpuMem] = useState("");
  const [switches, setSwitches] = useState<Record<SwitchId, boolean>>({
    tools: true, memory: true, autoLearn: true, autosave: true,
  });
  const tools = switches.tools;
  const memory = switches.memory;
  const [focus, setFocus] = useState<FieldId | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "warn" | "info" }>({ text: "", tone: "info" });
  const [saving, setSaving] = useState(false);
  const width = useShellWidth(72);
  const HEIGHT = 24;
  // A short terminal sheds decoration so every setting and the status line
  // still fit: first the blank lines between sections, then their headers.
  // The body gets the window minus borders, title, rule and hint bar.
  const term = useTerminalDimensions();
  const room = Math.min(HEIGHT, useShellHeight(term.height)) - 5;
  const labels = room >= 16;
  const gaps = room >= 18;

  useEffect(() => {
    bridge
      .request("config.get")
      .then((d) => {
        setCfg(d);
        setOllama(d.ollama_api_url ?? "");
        setWorkdir(d.project_dir ?? "");
        setModel(d.default_chat_model ?? "");
        setMemoryModel(d.memory_model ?? "");
        setGpuMem(d.ollama_gpu_memory_gb ? String(d.ollama_gpu_memory_gb) : "");
        setSwitches({
          tools: !!d.tools_enabled,
          memory: !!d.memory_enabled,
          autoLearn: d.memory_auto !== false,
          autosave: d.history_autosave !== false,
        });
      })
      .catch((e) => setStatus({ text: `load failed: ${(e as Error).message}`, tone: "warn" }));
    if (session.modelName)
      bridge
        .request("hardware.recommend_context", { model: session.modelName })
        .then((d) => setCtxInfo({ context: d.context || session.contextLength, manual: (d.manual || 0) > 0 }))
        .catch(() => setCtxInfo({ context: session.contextLength, manual: false }));
  }, []);

  /** `latest` carries the value of the field Enter was pressed in: after a
   *  paste + quick Enter, React state may not have caught up with the input. */
  const save = async (latest: Partial<Record<FieldId, string>> = {}) => {
    if (!cfg || saving) return;
    setSaving(true);
    setFocus(null);
    const v = { ollama, gpuMem, workdir, model, memoryModel, ...latest };
    const gpuN = v.gpuMem.trim() ? Number(v.gpuMem.trim().replace(",", ".")) : 0;
    if (!Number.isFinite(gpuN) || gpuN < 0 || gpuN > 1024) {
      setStatus({ text: `Not saved: GPU memory must be a number of GB (e.g. 8), or empty.`, tone: "warn" });
      setSaving(false);
      return;
    }
    const ollamaChanged = v.ollama.trim() !== (cfg.ollama_api_url ?? "");
    let note = "";
    try {
      if (ollamaChanged) {
        setStatus({ text: `checking ${v.ollama.trim()}…`, tone: "info" });
        const check = await bridge.request("ollama.check", { url: v.ollama });
        // Saved either way (the server may simply not be up yet), but say so.
        note = check.ok ? `  Ollama ${check.version} at ${check.url}.` : `  ⚠ ${check.url} unreachable: ${check.error}`;
      }
      const patch: Record<string, unknown> = {
        ollama_api_url: v.ollama,
        ...(fixedWorkdir === undefined ? { project_dir: v.workdir } : {}),
        default_chat_model: v.model.trim() || cfg.default_chat_model,
        memory_model: v.memoryModel.trim(),
        ollama_gpu_memory_gb: gpuN,
        tools_enabled: tools,
        memory_enabled: memory,
      };
      const d = await bridge.request("config.set", { patch });
      setCfg(d);
      setOllama(d.ollama_api_url ?? "");
      setWorkdir(d.project_dir ?? "");
      setGpuMem(d.ollama_gpu_memory_gb ? String(d.ollama_gpu_memory_gb) : "");
      onPatchSession({ toolsEnabled: tools, memoryEnabled: memory });
      onEngineChanged?.({ workdir: d.workdir ?? "", ollamaChanged });
      setStatus({ text: `Settings saved.${note}`, tone: note.includes("⚠") ? "warn" : "ok" });
    } catch (e) {
      setStatus({ text: `Not saved: ${(e as Error).message || e}`, tone: "warn" });
    } finally {
      setSaving(false);
    }
  };

  /** Switches take effect at once, like switches: flip and save just that
   *  field (text fields still wait for Enter). They used to need a separate
   *  save, and Enter did nothing unless a text field was focused. */
  const toggle = async (which: SwitchId) => {
    const sw = SWITCHES[which];
    const next = !switches[which];
    setSwitches((v) => ({ ...v, [which]: next }));
    try {
      const d = await bridge.request("config.set", { patch: { [sw.config]: next } });
      setCfg(d);
      if (sw.session) onPatchSession({ [sw.session]: next });
      setStatus({ text: `${sw.label} ${next ? "on" : "off"} — saved.`, tone: "ok" });
    } catch (e) {
      setSwitches((v) => ({ ...v, [which]: !next }));
      setStatus({ text: `${sw.label} not changed: ${(e as Error).message || e}`, tone: "warn" });
    }
  };

  const moveFocus = (step: number) =>
    setFocus((f) => {
      const ring = fixedWorkdir === undefined ? FIELDS : FIELDS.filter((x) => x !== "workdir");
      const i = f == null ? (step > 0 ? -1 : 0) : ring.indexOf(f);
      return ring[(i + step + ring.length) % ring.length]!;
    });

  /** The context window for the current model, by hand or automatic. */
  const openContext = () => {
    if (!session.modelName) {
      setStatus({ text: "Select a model first.", tone: "warn" });
      return;
    }
    modals
      .push<void>((close) => (
        <ContextConfigModal
          model={session.modelName!}
          current={ctxInfo?.context ?? session.contextLength}
          onApply={(n, manual) => {
            onPatchSession({ contextLength: n, ctxMax: n });
            setCtxInfo({ context: n, manual });
            setStatus({
              text: `Context for ${session.modelName}: ${n.toLocaleString()} tokens (${manual ? "manual" : "automatic"}) — saved.`,
              tone: "ok",
            });
            close();
          }}
          onClose={() => close()}
        />
      ))
      .catch(() => {});
  };

  const openTemperature = () => {
    modals
      .push<void>((close) => (
        <TemperatureModal
          value={temperature}
          onSave={(t) => {
            const v = Math.round(t * 10) / 10;
            onTemperature?.(v);
            setTemperatureShown(v);
            setStatus({ text: `Temperature ${v.toFixed(1)} — saved.`, tone: "ok" });
          }}
          onClose={() => close()}
        />
      ))
      .catch(() => {});
  };

  // Letter shortcuts only while no field is being typed into.
  const typing = () => focus != null;
  useModalKeys([
    { key: "escape", run: () => (focus ? setFocus(null) : onClose()) },
    { key: "tab", run: () => moveFocus(1) },
    { key: "shift+tab", run: () => moveFocus(-1) },
    { key: "ctrl+s", run: () => void save() },
  ]);
  useModalKeys(
    [
      { key: "return", run: () => void save() },
      { key: "s", run: () => void save() },
      ...(Object.keys(SWITCHES) as SwitchId[]).map((id) => ({ key: SWITCHES[id].key, run: () => void toggle(id) })),
      { key: "c", run: () => openContext() },
      { key: "e", run: () => openTemperature() },
    ],
    { enabled: () => !typing() },
  );

  const field = (id: FieldId, label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <FieldRow
      label={label}
      value={value}
      placeholder={placeholder}
      focused={focus === id}
      onFocus={() => setFocus(id)}
      onInput={set}
      onSubmit={(value) => void save({ [id]: value })}
    />
  );

  const tone = status.tone === "ok" ? theme.success : status.tone === "warn" ? theme.warn : theme.fg2;
  return (
    <ModalShell
      title="Settings"
      width={width}
      height={HEIGHT}
      hints={[
        ["tab", "field"],
        ["enter", "save"],
        ["t/m/a/h", "switch"],
      ]}
    >
      <box flexDirection="column" flexGrow={1}>
        {labels ? <SectionLabel label="engine" width={width - 4} /> : null}
        {field("ollama", "Ollama server", ollama, setOllama, "http://localhost:11434")}
        {field("gpuMem", "Ollama GPU memory", gpuMem, setGpuMem, "GB · empty = learned from chats")}
        {fixedWorkdir !== undefined ? (
          <box flexDirection="row" height={1} flexShrink={0}>
            <text fg={theme.fg2}>{`  ${"Working directory".padEnd(18)}`}</text>
            <text fg={theme.fg0}>{` ${fit(`${fixedWorkdir} (this folder)`, width - 26)}`}</text>
          </box>
        ) : (
          field(
            "workdir",
            "Working directory",
            workdir,
            setWorkdir,
            // Empty = the launch directory; show which one that currently is.
            `empty = launch dir (${fit(cfg?.workdir ?? "…", width - 48)})`,
          )
        )}

        <box marginTop={gaps ? 1 : 0} flexDirection="column">
          {labels ? <SectionLabel label="defaults" width={width - 4} /> : null}
          {field("model", "Default model", model, setModel, "ollama model tag")}
          <box onMouseDown={openContext}>
            <text>
              <span fg={theme.fg2}>{`  ${"Context".padEnd(19)}`}</span>
              <span fg={theme.fg0}>
                {session.modelName
                  ? fit(`${session.modelName} · ${ctxInfo ? `${ctxInfo.manual ? "manual" : "auto"} ${ctxLabel(ctxInfo.context)}` : "…"}`, width - 36)
                  : "no model selected"}
              </span>
              <span fg={theme.fg2}>{"   c to change"}</span>
            </text>
          </box>
          <box onMouseDown={openTemperature}>
            <text>
              <span fg={theme.fg2}>{`  ${"Temperature".padEnd(19)}`}</span>
              <span fg={theme.fg0}>{`${temperature.toFixed(1)} · ${temperatureLabel(temperature)}`}</span>
              <span fg={theme.fg2}>{"   e to change"}</span>
            </text>
          </box>
        </box>

        <box marginTop={gaps ? 1 : 0} flexDirection="column">
          {labels ? <SectionLabel label="session" width={width - 4} /> : null}
          {(Object.keys(SWITCHES) as SwitchId[]).map((id) => (
            <ToggleRow key={id} label={SWITCHES[id].label} value={switches[id]} onToggle={() => void toggle(id)} />
          ))}
          {field("memoryModel", "Memory model", memoryModel, setMemoryModel, "empty = the chat model")}
        </box>
      </box>

      {/* Two lines: an unreachable-server reason must not be cut off. */}
      <box flexShrink={0} height={2}>
        <text fg={tone}>{status.text || " "}</text>
      </box>
    </ModalShell>
  );
}

const CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

/** "24k" / "24K" / "1.5k" / "16,384" → tokens; null when it isn't a size. */
export function parseContext(raw: string): number | null {
  const m = raw.trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)(k?)$/);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] ? 1024 : 1));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 16384 → "16K", as the model card shows it. */
export const ctxLabel = (n: number) => `${Math.max(1, Math.round(n / 1024))}K`;

/**
 * The context window for one model, by hand: any size (also more than fits
 * the hardware — then part of the model runs on the CPU), or back to
 * automatic. Saved per model in the engine's config (context.set).
 */
export function ContextConfigModal({
  model,
  current,
  onApply,
  onClose,
}: {
  model: string;
  current: number;
  /** The context now in effect for this model, and whether it is manual. */
  onApply: (n: number, manual: boolean) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [info, setInfo] = useState<{ manual: number; fits: number } | null>(null);
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState(false);
  const inputEl = useRef<any>(null);
  const lastSubmit = useRef(0);
  const rows = [...CTX_OPTIONS, 0];                            // 0 = "custom…"
  const [sel, setSel] = useState(() => Math.max(0, CTX_OPTIONS.indexOf(current)));
  const width = useShellWidth(64);

  useEffect(() => {
    bridge
      .request("hardware.recommend_context", { model })
      .then((d) => setInfo({ manual: d.manual || 0, fits: d.fits || d.context || 0 }))
      .catch((e) => setNote(String((e as Error).message || e)));
  }, [model]);

  const apply = (n: number) => {
    setNote("");
    bridge
      .request("context.set", { model, context: n })
      .then((d) => {
        const manual = d.manual || 0;
        setInfo((i) => (i ? { ...i, manual } : i));
        setCustom(false);
        onApply(manual || info?.fits || current, manual > 0);
        if (d.note) setNote(d.note);
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const submitCustom = (v?: string) => {
    if (Date.now() - lastSubmit.current < 200) return;     // Enter reaches keymap and input
    lastSubmit.current = Date.now();
    const n = parseContext(String(v ?? inputEl.current?.value ?? ""));
    if (n == null) return setNote("Type a number of tokens, e.g. 24k or 24576.");
    apply(n);
  };

  const choose = () => {
    const n = rows[sel];
    if (n === 0) return setCustom(true);
    if (n != null) apply(n);
  };

  useModalKeys([
    { key: "escape", run: () => (custom ? setCustom(false) : onClose()) },
    { key: "return", run: () => (custom ? submitCustom() : choose()) },
  ]);
  useModalKeys(
    [
      { key: "up", run: () => setSel((s) => Math.max(0, s - 1)) },
      { key: "down", run: () => setSel((s) => Math.min(rows.length - 1, s + 1)) },
      { key: "a", run: () => info?.manual && apply(0) },
    ],
    { enabled: () => !custom },
  );

  const head = !info
    ? note || "checking hardware…"
    : info.manual
      ? `manual: ${info.manual.toLocaleString()} tokens · fits: ${info.fits.toLocaleString()} · a = automatic`
      : `automatic: ${info.fits.toLocaleString()} tokens — what fits your hardware`;

  return (
    <ModalShell
      title={`Context — ${fit(model, 36)}`}
      width={width}
      height={rows.length + 10}
      hints={custom ? [["enter", "set"], ["esc", "back"]] : [["↑↓", "select"], ["enter", "set"], ["a", "automatic"]]}
    >
      <text fg={info ? theme.fg1 : theme.warn}>{`  ${fit(head, width - 6)}`}</text>
      <box flexDirection="column" paddingTop={1} flexGrow={1}>
        {rows.map((n, i) => {
          const selected = i === sel && !custom;
          const isCurrent = n === current;
          const tag = n === 0
            ? ""
            : info && n === info.fits
              ? "  ✓ fits"
              : info && n > info.fits
                ? "  · more than fits — part runs on the CPU"
                : "";
          return (
            <box key={n} onMouseDown={() => setSel(i)} backgroundColor={selected ? theme.bg3 : undefined}>
              <text attributes={lift(selected)}>
                <span fg={selected ? theme.accent : theme.border}>{"▎"}</span>
                <span fg={selected ? theme.fg0 : theme.fg1}>{n === 0 ? " custom…" : ` ${n.toLocaleString().padStart(7)}`}</span>
                {isCurrent ? <span fg={theme.fg2}>{"  current"}</span> : null}
                <span fg={n && info && n > info.fits ? theme.warn : theme.success}>{tag}</span>
              </text>
            </box>
          );
        })}
      </box>
      {custom ? (
        <box border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.bg2} flexShrink={0} paddingLeft={1}>
          <input
            ref={inputEl}
            onPaste={singleLinePaste}
            focused
            placeholder="Tokens, e.g. 24k or 24576"
            onSubmit={(v: unknown) => submitCustom(typeof v === "string" ? v : undefined)}
            backgroundColor={theme.bg2}
            textColor={theme.fg0}
            placeholderColor={theme.fg2}
            cursorColor={theme.accent}
          />
        </box>
      ) : null}
      {note ? <text fg={theme.warn}>{fit(`  ${note}`, width - 4)}</text> : null}
    </ModalShell>
  );
}
