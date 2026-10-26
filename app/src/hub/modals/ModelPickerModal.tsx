// Ported from AIhub-TUI v1.5.0 app/src/modals/ModelPickerModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useMemo, useRef, useState } from "react";
import { singleLinePaste } from "../clipboard.ts";
import type { ColorInput } from "@opentui/core";
import { theme, humanGb, fit, lift, track } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { useModals } from "../state/ModalContext.tsx";
import { ModalShell, useShellHeight, useShellWidth } from "../ui/ModalShell.tsx";
import { Spinner } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList, fuzzyScore, isTextInputFocused } from "./modalKit.ts";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  PullProgressModal,
  QuantPickerModal,
  GgufDownloadModal,
  type GgufFile,
} from "./DownloadModals.tsx";

type Tab = "installed" | "fit" | "ollama" | "hf" | "cloud";

/** aihub-code: the note of a picker opened while a turn runs. */
export const VIEW_ONLY = "A turn is running — look around; pick a model once it's done.";

// Row budget: shell (borders, title, rule, hints) 5 + tabs/filter 5 + note 1
// + list area VIEWPORT + 2. Catalog tabs spend 3 of the list area on the
// target header and column titles.
const MAX_VIEWPORT = 10;
const CHROME_ROWS = 13;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "installed", label: "Installed" },
  { id: "fit", label: "Fit" },
  { id: "ollama", label: "Ollama" },
  { id: "hf", label: "HF GGUF" },
  { id: "cloud", label: "Cloud" },
];

/** Score bar — 10 cells + right-aligned number (14 columns total). */
function ScoreBar({ score, fits }: { score: number; fits: boolean }) {
  const col = !fits ? theme.error : score >= 70 ? theme.success : theme.warn;
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return (
    <span>
      <span fg={col}>{`█`.repeat(filled)}</span>
      <span fg={track()}>{`░`.repeat(10 - filled)}</span>
      <span fg={col}>{String(Math.round(score)).padStart(4)}</span>
    </span>
  );
}

function TabBar({
  tab,
  setTab,
  loading,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  loading?: boolean;
}) {
  return (
    <box flexDirection="row" flexShrink={0}>
      {TABS.map((t, i) => {
        const active = t.id === tab;
        return (
          <text key={t.id} onMouseDown={() => setTab(t.id)}>
            <span fg={active ? theme.accent : theme.fg2} bg={active ? theme.bg3 : undefined} attributes={lift(active)}>
              {` ${i + 1} ${t.label} `}
            </span>
            <span fg={theme.border}>{" "}</span>
          </text>
        );
      })}
      {loading ? (
        <text fg={theme.fg2}>
          <Spinner color={theme.fg2} />
          {" …"}
        </text>
      ) : null}
    </box>
  );
}

export function ModelPickerModal({
  currentModel,
  installedSet,
  onPick,
  onClose,
  viewOnly = false,
}: {
  currentModel: string | null;
  /** Names already installed locally (refreshed by the parent on pick). */
  installedSet: Set<string>;
  onPick: (display: string, backend: "ollama" | "api", streamModel: string) => void;
  onClose: () => void;
  /** aihub-code: opened while a turn runs — browse and search, but no
   *  picking or pulling until the turn is over. */
  viewOnly?: boolean;
}) {
  const bridge = useBridge();
  const modals = useModals();
  const [tab, setTabRaw] = useState<Tab>("installed");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState(viewOnly ? VIEW_ONLY : "");
  const [loading, setLoading] = useState(true);

  const [installed, setInstalled] = useState<Array<{ name: string; size_gb: number }>>([]);
  const [cloud, setCloud] = useState<Array<any>>([]);
  // Ollama Cloud tags (run on ollama.com through the server) + plan status.
  const [ocloud, setOcloud] = useState<Array<any>>([]);
  const [probing, setProbing] = useState(false);

  // Fit tab — expensive (hardware detect + 150 model scores), so it loads once
  // per picker session when the tab is first opened.
  const [fitRows, setFitRows] = useState<any[]>([]);
  const [fitLoading, setFitLoading] = useState(false);
  // What the Fit / Ollama / HF numbers are computed for, and catalog age.
  const [targetInfo, setTargetInfo] = useState<any>(null);
  const [ages, setAges] = useState<Partial<Record<Tab, number | null>>>({});

  // Network search tabs — enter in the filter submits the search.
  const [ollamaRows, setOllamaRows] = useState<any[]>([]);
  const [hfRows, setHfRows] = useState<any[]>([]);
  const lastSearch = useRef<{ tab: Tab; query: string }>({ tab: "installed", query: "" });
  // The filter input is focused on demand via "/" (lazygit-style); the list
  // owns the keyboard otherwise, so digits keep switching tabs.
  const [filterFocused, setFilterFocused] = useState(false);
  // The input renderable owns its text; React batches per-keystroke updates, so
  // a fast "type + enter" would read a stale `query` state. Read through.
  const filterEl = useRef<any>(null);
  const currentQuery = () =>
    filterEl.current ? String(filterEl.current.value ?? "") : query;

  const setTab = (t: Tab) => {
    setTabRaw(t);
    setQuery("");
    if (filterEl.current) filterEl.current.value = "";
    if (t === "fit") runFit();
    // Catalog tabs list the cached catalog right away — no search needed.
    if (t === "ollama" && !ollamaRows.length) runSearch("ollama", "");
    if (t === "hf" && !hfRows.length) runSearch("hf", "");
    if (t === "cloud" && !ocloud.length) loadCloud();
  };

  /** Cloud tab: list Ollama Cloud tags, then check (once, cached a few days)
   *  which ones this account's plan includes. */
  const loadCloud = () => {
    setLoading(true);
    bridge
      .request("cloud.models")
      .then((d) => {
        const rows: any[] = d.models || [];
        setOcloud(rows);
        const unknown = rows.filter((r) => !r.status).map((r) => r.name);
        if (!unknown.length) return;
        setProbing(true);
        setNote("Checking which cloud models your Ollama plan includes…");
        return bridge
          .request("cloud.probe", { names: unknown })
          .then((r) => {
            const got = new Map<string, string>((r.results || []).map((x: any) => [x.name, x.status]));
            setOcloud((prev) => prev.map((m) => (got.has(m.name) ? { ...m, status: got.get(m.name) } : m)));
            setNote("");
          })
          .finally(() => setProbing(false));
      })
      .catch((e) => setNote(`Ollama Cloud: ${(e as Error).message || e}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const [inst, api] = await Promise.all([
          bridge.request("models.installed"),
          bridge.request("api.models").catch(() => ({ models: [] })),
        ]);
        if (!alive) return;
        setInstalled(inst.models || []);
        setCloud(api.models || []);
      } catch (e) {
        if (alive) setNote(String((e as Error).message || e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshInstalled = () =>
    bridge
      .request("models.installed")
      .then((d) => setInstalled(d.models || []))
      .catch((e) => setNote(`Refreshing installed models failed: ${(e as Error).message || e}`));

  const runFit = () => {
    if (fitLoading || fitRows.length) return;
    setFitLoading(true);
    bridge
      .request("models.recommend", { limit: 60 })
      .then((d) => {
        setTargetInfo(d.target || null);
        setAges((a) => ({ ...a, fit: d.catalog_age_s ?? null }));
        setFitRows(d.models || []);
      })
      .catch((e) => setNote(`Fit scan failed: ${(e as Error).message}`))
      .finally(() => setFitLoading(false));
  };

  const runSearch = (which: "ollama" | "hf", forced?: string) => {
    const q = (forced ?? currentQuery()).trim();
    lastSearch.current = { tab: which, query: q };
    setLoading(true);
    const req =
      which === "ollama"
        ? bridge.request("ollama.library", { query: q, limit: 60 })
        : bridge.request("hf.gguf", { query: q, limit: 40 });
    req
      .then((d) => {
        if (d.target) setTargetInfo(d.target);
        if (!q) setAges((a) => ({ ...a, [which]: d.catalog_age_s ?? null }));
        const rows = d.models || [];
        const clean = rows.filter((m: any) => !m.live_error);
        const err = rows.find((m: any) => m.live_error);
        if (which === "ollama") setOllamaRows(clean);
        else setHfRows(clean);
        if (err) setNote(err.live_error);
      })
      .catch((e) => setNote(String((e as Error).message || e)))
      .finally(() => setLoading(false));
  };

  const rows: Array<any> = useMemo(() => {
    const q = query.trim();
    if (tab === "installed")
      return installed
        .map((m: any) => ({
          key: m.name,
          kind: "installed",
          model: m.name,
          sub: m.cloud ? "cloud" : humanGb(m.size_gb),
          status: m.cloud ? m.status || "" : undefined,
          caps: m.capabilities || [],
          params: m.params || "",
          ctx: m.max_context || 0,
        }))
        .filter((r) => fuzzyScore(q, r.model) >= 0)
        .sort((a, b) => fuzzyScore(q, b.model) - fuzzyScore(q, a.model));
    if (tab === "cloud")
      return [
        ...ocloud.map((m) => ({
          key: `ocloud:${m.name}`,
          kind: "ocloud",
          model: m.name,
          sub: "ollama",
          status: m.status || "",
          caps: m.capabilities || [],
          desc: m.description || "",
        })),
        ...cloud.map((m) => ({
          key: m.url,
          kind: "cloud",
          model: m.name,
          sub: `${Math.round((m.context_window || 0) / 1024)}K ctx`,
          url: m.url,
          keyReady: !!m.key_ready,
        })),
      ].filter((r) => fuzzyScore(q, r.model) >= 0);
    const local = (r: any) => fuzzyScore(q, r.name) >= 0;
    if (tab === "fit") return fitRows.map((r) => ({ key: r.name, kind: "fit", ...r })).filter(local);
    if (tab === "ollama") return ollamaRows.map((m) => ({ key: m.name, kind: "ollama", ...m }));
    return hfRows.map((m) => ({ key: m.name, kind: "hf", ...m }));
  }, [tab, query, installed, cloud, ocloud, fitRows, ollamaRows, hfRows]);

  const catalogTab = tab === "fit" || tab === "ollama" || tab === "hf";
  const term = useTerminalDimensions();
  // aihub-code: in the footer the window is the panel's height.
  const VIEWPORT = Math.max(4, Math.min(MAX_VIEWPORT, useShellHeight(term.height - 1) - CHROME_ROWS));
  // A two-line note (a failed pull says why and what to do) takes a list row.
  const shellW = useShellWidth(Math.max(60, Math.min(110, term.width - 4)));
  const noteRows = note.length > shellW - 6 ? 2 : 1;
  const listRows = (catalogTab ? VIEWPORT - 1 : VIEWPORT + 1) - (noteRows - 1);
  const list = useWindowedList(rows.length, listRows);

  // Ollama lists "qwen3:8b"; a bare family name means ":latest".
  const installedNames = useMemo(() => new Set(installed.map((m) => m.name)), [installed]);
  const installedName = (name: string) =>
    installedNames.has(name) ? name : installedNames.has(`${name}:latest`) ? `${name}:latest` : name;
  const isInstalled = (name: string) => installedNames.has(installedName(name));

  const pickInstalled = (name: string) => {
    onPick(name, "ollama", name);
    onClose();
  };

  const pullOllama = (tag: string) => {
    modals
      .push<any>((close) => <PullProgressModal name={tag} onClose={close} />)
      .then((result) => {
        if (result?.error) return setNote(`Pull failed: ${result.error}`);
        if (result?.cancelled) return setNote("Pull cancelled.");
        setNote(`Pulled ${tag}.`);
        refreshInstalled();
      })
      .catch((err) => setNote(`Pull failed: ${err?.message || err}`));
  };

  const downloadGguf = (repoId: string, file: GgufFile) => {
    modals
      .push<any>((close) => <GgufDownloadModal repoId={repoId} file={file} onClose={close} />)
      .then((result) => {
        if (result?.error) return setNote(`Download failed: ${result.error}`);
        if (result?.cancelled) return setNote("Download cancelled.");
        refreshInstalled();
        if (result?.name) {
          // Touchless: imported → select it immediately.
          onPick(result.name, "ollama", result.name);
          onClose();
        }
      })
      .catch((err) => setNote(`Download failed: ${err?.message || err}`));
  };

  const pickQuant = (repoId: string, files: GgufFile[]) => {
    modals
      .push<void>((close) => (
        <QuantPickerModal
          repoId={repoId}
          files={files}
          onPick={(f) => downloadGguf(repoId, f)}
          onClose={close}
        />
      ))
      .catch(() => {});
  };

  const activate = () => {
    const row: any = rows[list.index];
    // Network tabs: enter with a fresh query searches; enter on results picks.
    if (!row || ((tab === "ollama" || tab === "hf") && lastSearch.current.query !== currentQuery().trim())) {
      if (tab === "ollama" || tab === "hf") return runSearch(tab);
      return;
    }
    if (viewOnly) return setNote(VIEW_ONLY);
    // Ollama Cloud: runs through the server, nothing to download — unless
    // the plan doesn't include it or Ollama retired it.
    if ((row.kind === "ocloud" || row.kind === "installed") && row.status === "paid")
      return setNote(`${row.model} isn't in Ollama's free cloud plan — it needs credits (ollama.com/settings).`);
    if ((row.kind === "ocloud" || row.kind === "installed") && row.status === "retired")
      return setNote(`Ollama retired ${row.model} — pick another. Remove it on the server: ollama rm ${row.model}`);
    if (row.kind === "ocloud") {
      onPick(row.model, "ollama", row.model);
      onClose();
      return;
    }
    if (row.kind === "installed") return pickInstalled(row.model);
    if (row.kind === "cloud") {
      if (!row.keyReady) return setNote(`${row.model}: no API key configured for this provider.`);
      onPick(row.model, "api", row.url);
      onClose();
      return;
    }
    // Fit rows and the Ollama tab's best variant are Ollama tags: use it if
    // installed, otherwise pull it.
    const useOrPull = (name: string) => (isInstalled(name) ? pickInstalled(installedName(name)) : pullOllama(name));
    if (row.kind === "fit") return useOrPull(row.name);
    if (row.kind === "ollama") return useOrPull(row.best?.name || row.name);
    if (row.kind === "hf") {
      const files: GgufFile[] = row.gguf_files || [];
      if (files.length) return pickQuant(row.name, files);
      setNote(`Fetching quants for ${row.name}…`);
      bridge
        .request("hf.gguf_files", { model_id: row.name })
        .then((d) => {
          const got: GgufFile[] = d.files || [];
          if (!got.length) return setNote(`${row.name}: no GGUF files found.`);
          setNote("");
          pickQuant(row.name, got);
        })
        .catch((e) => setNote(String((e as Error).message || e)));
    }
  };

  // Digits double as text — while the filter input owns the keyboard they must
  // type, not switch tabs (typing "qwen3" would otherwise jump to tab 3).
  const renderer = useRenderer();
  const digitGate = useRef(() => !isTextInputFocused(renderer));
  digitGate.current = () => !isTextInputFocused(renderer);
  const focusFilter = () => setFilterFocused(true);
  // esc is layered: clear the query → leave the filter → close the modal.
  const onEscape = () => {
    if (filterFocused && currentQuery().trim()) {
      setQuery("");
      if (filterEl.current) filterEl.current.value = "";
      return;
    }
    if (filterFocused) {
      setFilterFocused(false);
      if (filterEl.current) filterEl.current.blur?.();
      return;
    }
    onClose();
  };

  useModalKeys([
    { key: "escape", run: onEscape },
    { key: "up", run: list.up },
    { key: "down", run: list.down },
    { key: "return", run: activate },
    { key: "slash", run: focusFilter },
    { key: "/", run: focusFilter },
  ]);
  useModalKeys(
    TABS.map((t, i) => ({ key: String(i + 1), run: () => setTab(t.id) })),
    { enabled: () => digitGate.current() },
  );

  // Fill the terminal up to 110 columns; the name column takes the slack.
  const width = shellW;
  const nameW = Math.max(16, Math.min(34, width - FIXED_COLS - 4 - 12));
  const extraW = Math.max(0, width - 4 - FIXED_COLS - nameW);
  // Installed / Cloud: one name column as wide as the longest name shown,
  // but never so wide that the size columns are pushed off the row.
  const plainW = Math.min(38, width - 4 - 36, Math.max(10, ...rows.map((r: any) => String(r.model ?? "").length)));
  /** Cells left on an Installed / Cloud row after its fixed columns — what
   *  the capability badges and the description may use. A row must stay one
   *  line: a wrapped row pushes the list over the hint bar and out of the
   *  window. */
  const restOf = (row: any) =>
    width - 4 -
    (2 + plainW + 10 +
      (row.kind === "installed" ? 14 : 0) +
      (row.keyReady === false ? 10 : 0) +
      (row.status !== undefined || row.kind === "installed" ? 10 : 0));
  return (
    <ModalShell
      title="Models"
      width={width}
      height={VIEWPORT + CHROME_ROWS}
      hints={[
        ["↑↓", "select"],
        ["enter", tab === "ollama" || tab === "hf" ? "search / use" : "use"],
        ["/", "search"],
        ["1-5", "tab"],
      ]}
    >
      <TabBar tab={tab} setTab={setTab} loading={loading || fitLoading} />

      {/* filter / search */}
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.bg2}
        flexShrink={0}
        paddingLeft={1}
        marginTop={1}
      >
        <input
          onPaste={singleLinePaste}
          ref={filterEl}
          value={query}
          onInput={(v: string) => setQuery(v)}
          onSubmit={() => {
            if (tab === "ollama" || tab === "hf") runSearch(tab);
          }}
          focused={filterFocused}
          placeholder={
            tab === "ollama"
              ? "search the Ollama library…  (enter)"
              : tab === "hf"
                ? "search HuggingFace GGUF…  (enter)"
                : "filter…"
          }
          backgroundColor={theme.bg2}
          textColor={theme.fg0}
          placeholderColor={theme.fg2}
          cursorColor={theme.accent}
        />
      </box>

      {/* target header — always one line on catalog tabs (counted in the
          modal height, so rows never slide onto the hint bar) */}
      {catalogTab ? (
        <box flexShrink={0} height={1} marginTop={1}>
          <text>
            <span fg={theme.fg1}>{fit(targetHeader(targetInfo), width - 4 - 13 - humanAge(ages[tab]).length)}</span>
            <span fg={theme.fg2}>{`  ·  catalog ${humanAge(ages[tab])}`}</span>
          </text>
        </box>
      ) : null}
      {catalogTab ? (
        <box flexShrink={0} height={1}>
          <text fg={theme.fg2}>{"  " + columnsHeader(nameW)}</text>
        </box>
      ) : null}

      {/* rows — fixed viewport: rows never compress (flex-shrink overlap
          renders as two rows drawn into the same cells) */}
      <box
        flexDirection="column"
        height={catalogTab ? listRows : listRows + 1}
        flexShrink={0}
        paddingTop={catalogTab || tab === "installed" ? 0 : 1}
      >
        {tab === "installed" ? (
          <box flexShrink={0} height={1}>
            <text fg={theme.fg2}>
              {`  ${"model".padEnd(plainW)}  ${"size".padStart(8)}${"params".padStart(7)}${"ctx".padStart(7)}${"".padEnd(10)}  can do`}
            </text>
          </box>
        ) : null}
        {rows.slice(list.start, list.end).map((row: any, i) => {
          const idx = list.start + i;
          const selected = idx === list.index;
          return (
            <box
              key={row.key}
              flexShrink={0}
              height={1}
              backgroundColor={selected ? theme.bg3 : undefined}
              onMouseDown={() => list.setIndex(idx)}
            >
              {catalogTab ? (
                <CatalogRow
                  row={catalogCells(row)}
                  selected={selected}
                  installed={isInstalled(catalogCells(row).name)}
                  nameW={nameW}
                  extraW={extraW}
                />
              ) : (
                <text wrapMode="none" attributes={lift(selected)}>
                  <span fg={selected ? theme.accent : theme.border}>{"▎"}</span>
                  <span fg={row.model === currentModel ? theme.accentSoft : selected ? theme.fg0 : theme.fg1}>
                    {` ${fit(row.model, 38).padEnd(plainW)}`}
                  </span>
                  <span fg={theme.fg2}>{`  ${row.sub.padStart(8)}`}</span>
                  {row.kind === "installed" ? (
                    <span fg={theme.fg2}>{`${(row.params || "").padStart(7)}${humanCtx(row.ctx).padStart(7)}`}</span>
                  ) : null}
                  {row.keyReady === false ? <span fg={theme.warn}>{"  ⚲ no key"}</span> : null}
                  {row.status !== undefined ? (
                    <StatusBadge status={row.status} probing={probing} />
                  ) : row.kind === "installed" ? (
                    <span>{" ".repeat(10)}</span>
                  ) : null}
                  {row.caps ? (
                    <CapBadges caps={row.caps} width={row.desc !== undefined ? 36 : 0} max={restOf(row)} />
                  ) : null}
                  {row.desc ? (
                    <span fg={theme.fg2}>
                      {fit(row.desc, Math.max(0, restOf(row) - (row.caps ? Math.min(36, restOf(row)) : 0)))}
                    </span>
                  ) : null}
                </text>
              )}
            </box>
          );
        })}
        {rows.length === 0 ? (
          <text fg={theme.fg2}>
            {tab === "fit" && fitLoading
              ? "  scoring models for your hardware…"
              : (tab === "ollama" || tab === "hf") && loading
                ? "  loading the catalog…"
                : (tab === "installed" || tab === "cloud") && loading
                  ? "  loading your models…"
                  : `  no matches${query ? ` for “${query}”` : ""}`}
          </text>
        ) : null}
      </box>

      {/* Up to two lines: a failed pull says why and what to do. */}
      {note ? (
        <box flexShrink={0} height={noteRows}>
          <text fg={theme.warn} wrapMode="word">{fit(note, 2 * (width - 6))}</text>
        </box>
      ) : null}
    </ModalShell>
  );
}

/** What a model can do: tools, thinking, vision… — the same words Ollama uses. */
const CAP_ORDER = ["tools", "thinking", "vision", "audio", "insert"];
const CAP_STYLE: Record<string, [string, ColorInput]> = {
  tools: ["tools", theme.success],
  thinking: ["thinking", theme.fg1],
  vision: ["vision", theme.accentSoft],
  audio: ["audio", theme.warn],
  insert: ["fill-in", theme.fg2],
};

function CapBadges({ caps, width = 0, max = Infinity }: { caps: string[]; width?: number; max?: number }) {
  // As many as fit in `max` cells, most useful first; the rest are dropped.
  const shown: string[] = [];
  for (const c of CAP_ORDER.filter((c) => caps.includes(c))) {
    if (2 + [...shown, c].map((x) => CAP_STYLE[x]![0]).join(" · ").length > max) break;
    shown.push(c);
  }
  const len = shown.length ? 2 + shown.map((c) => CAP_STYLE[c]![0]).join(" · ").length : 3;
  if (!shown.length && max < 3) return null;
  const pad = " ".repeat(Math.max(0, Math.min(width, max) - len));
  if (!shown.length) return <span fg={theme.border}>{`  —${pad}`}</span>;
  return (
    <span>
      {shown.map((c, i) => (
        <span key={c}>
          <span fg={theme.borderStrong}>{i ? " · " : "  "}</span>
          <span fg={CAP_STYLE[c]![1]}>{CAP_STYLE[c]![0]}</span>
        </span>
      ))}
      {pad}
    </span>
  );
}

/** 262144 → "256K ctx", 128000 → "128K ctx". */
function humanCtx(n: number): string {
  if (!n) return "";
  const k = n % 1000 === 0 ? n / 1000 : Math.round(n / 1024);
  return `${k}K`;
}

/** Ollama Cloud plan status of a model. */
const STATUS: Record<string, [string, ColorInput]> = {
  free: ["free", theme.success],
  paid: ["paid", theme.warn],
  retired: ["retired", theme.error],
  limit: ["limit", theme.warn],
  signin: ["sign in", theme.error],
  missing: ["missing", theme.error],
  error: ["error", theme.error],
};

function StatusBadge({ status, probing }: { status: string; probing: boolean }) {
  const [label, color] = STATUS[status] ?? [probing ? "checking" : "?", theme.fg2];
  return <span fg={color}>{`  ${label.padEnd(8)}`}</span>;
}

/** Display cells shared by the Fit / Ollama / HF tabs. */
type Cells = {
  name: string;
  size_gb: number;
  fits: boolean;
  placement: string;
  est_tps: number;
  basis: string;
  score: number;
  extra: string;
};

/** Normalize the three row shapes: Fit rows and HF rows carry `fit`
 *  directly; Ollama library rows carry it on their best variant. */
export function catalogCells(row: any): Cells {
  const src = row.kind === "ollama" ? row.best ?? {} : row;
  const f = src.fit ?? {};
  const caps: string[] = (row.capabilities ?? []).filter((c: string) => c !== "cloud");
  const extra =
    row.kind === "hf"
      ? String(row.description ?? "")
      : [caps.join(" "), row.updated].filter(Boolean).join(" · ") || String(row.description ?? "");
  return {
    name: String(src.name ?? row.name ?? "?"),
    size_gb: Number(src.size_gb ?? 0),
    fits: !!f.fits,
    placement: String(f.placement ?? "none"),
    est_tps: Number(f.est_tps ?? 0),
    basis: String(f.basis ?? "estimated"),
    score: Number(f.score ?? 0),
    extra,
  };
}

// Column widths after the name: size · speed · placement · score bar.
const SIZE_W = 7;
const TPS_W = 10;
const PLACE_W = 6;
const BAR_W = 14; // 10 cells + " 100"
const FIXED_COLS = 2 + SIZE_W + TPS_W + PLACE_W + BAR_W + 4;

const pad = (t: string, w: number) => fit(t, w).padEnd(w);
const padL = (t: string, w: number) => fit(t, w).padStart(w);

export function columnsHeader(nameW: number): string {
  return `${pad("model", nameW)}${padL("size", SIZE_W)}${padL("speed", TPS_W)}  ${pad("where", PLACE_W)}score`;
}

/** "~7 t/s" estimated, "7 t/s✓" measured, "—" when it can't run. */
export function tpsLabel(c: Pick<Cells, "fits" | "est_tps" | "basis">): string {
  if (!c.fits || !c.est_tps) return "—";
  const n = c.est_tps >= 10 ? Math.round(c.est_tps) : Math.round(c.est_tps * 10) / 10;
  return c.basis === "measured" ? `${n} t/s✓` : `~${n} t/s`;
}

const PLACE: Record<string, [string, ColorInput]> = {
  gpu: ["GPU", theme.success],
  partial: ["part", theme.warn],
  cpu: ["CPU", theme.warn],
  none: ["✗", theme.error],
};

function CatalogRow({
  row,
  selected,
  installed,
  nameW,
  extraW,
}: {
  row: Cells;
  selected: boolean;
  installed: boolean;
  nameW: number;
  extraW: number;
}) {
  const col = !row.fits ? theme.error : row.score >= 70 ? theme.success : theme.warn;
  const [place, placeCol] = PLACE[row.placement] ?? PLACE.none!;
  const fast = row.est_tps >= 10 ? theme.success : row.est_tps >= 3 ? theme.warn : theme.error;
  return (
    <text attributes={lift(selected)}>
      <span fg={selected ? theme.accent : col}>{"▎"}</span>
      <span fg={theme.accentSoft}>{installed ? "✓" : " "}</span>
      <span fg={row.fits ? (selected ? theme.fg0 : theme.fg1) : theme.fg2}>{pad(row.name, nameW)}</span>
      <span fg={theme.fg2}>{padL(humanGb(row.size_gb), SIZE_W)}</span>
      <span fg={row.fits ? fast : theme.fg2}>{padL(tpsLabel(row), TPS_W)}</span>
      <span fg={placeCol}>{`  ${pad(place, PLACE_W)}`}</span>
      <ScoreBar score={row.score} fits={row.fits} />
      {extraW > 2 ? <span fg={theme.fg2}>{`  ${fit(row.extra, extraW - 1)}`}</span> : null}
    </text>
  );
}

/** "fit for server 192.0.2.10 · GPU ~8 GB learned · 37 GB/s measured". */
export function targetHeader(t: any): string {
  if (!t) return "fit for …";
  const gpu = t.vram_gb ? `GPU ~${t.vram_gb} GB ${t.vram_basis}` : "no GPU";
  return `fit for ${t.label} · ${gpu} · ${Math.round(t.bw_eff)} GB/s ${t.bw_basis}`;
}

export function humanAge(s: number | null | undefined): string {
  if (s === undefined) return "…";
  if (s === null) return "not downloaded yet";
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
