// Ported from AIhub-TUI v1.5.0 app/src/modals/DownloadModals.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useRef, useState } from "react";
import { theme, humanGb, fit, lift, track } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { Spinner } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList } from "./modalKit.ts";

// ── Ollama pull (download.ollama) ────────────────────────────────────────────

/** Progress panel for an `ollama pull`. Owns the download stream so progress
 *  events flow straight into the meter. */
export function PullProgressModal({
  name,
  onClose,
}: {
  name: string;
  onClose: (value: any) => void;
}) {
  const bridge = useBridge();
  const [status, setStatus] = useState("starting…");
  const [pct, setPct] = useState(0);
  const [done, setDone] = useState(false);
  const streamId = useRef<number | null>(null);
  const width = useShellWidth(56);

  useEffect(() => {
    const { id, done: finished } = bridge.stream(
      "download.ollama",
      { name },
      {
        onEvent: (event, data) => {
          if (event !== "progress") return;
          const total = data.total || 0;
          setStatus(data.status || "pulling…");
          if (total > 0) setPct(Math.min(100, ((data.completed || 0) / total) * 100));
        },
      },
    );
    streamId.current = id;
    finished
      .then((d) => {
        setPct(100);
        setDone(true);
        setTimeout(() => onClose(d ?? {}), 400);
      })
      .catch((e) => setTimeout(() => onClose({ error: String(e?.message || e) }), 400));
    return () => {
      if (streamId.current != null) bridge.cancel(streamId.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useModalKeys([
    { key: "escape", run: () => onClose({ cancelled: true }) },
    { key: "c", run: () => onClose({ cancelled: true }) },
  ]);

  return (
    <ModalShell title={`Pulling ${name}`} width={width} hints={[["esc", "cancel"]]}>
      <box marginTop={1}>
        <text>
          {done ? <span fg={theme.success}>✓</span> : <Spinner color={theme.accent} />}
          <span fg={theme.fg1}>{` ${done ? "complete" : status}`}</span>
        </text>
      </box>
      <box marginTop={1}>
        <text>
          <span fg={theme.accent}>{"━".repeat(Math.round((pct / 100) * (width - 6)))}</span>
          <span fg={track()}>{"━".repeat(width - 6 - Math.round((pct / 100) * (width - 6)))}</span>
          <span fg={theme.fg2}>{` ${Math.round(pct)}%`}</span>
        </text>
      </box>
      <box marginTop={1}>
        <text fg={theme.fg2}>{"Streaming layers from the Ollama registry — esc cancels."}</text>
      </box>
    </ModalShell>
  );
}

// ── GGUF quant picker ────────────────────────────────────────────────────────

export interface GgufFile {
  filename: string;
  size_bytes?: number;
  size_gb?: number;
  quant?: string;
  recommended?: boolean;
  quality?: boolean;
}

const QUANT_VIEWPORT = 12;

/** Pick a GGUF quantisation for a HuggingFace repo. Enter resolves with the
 *  chosen file; the caller owns the download. */
export function QuantPickerModal({
  repoId,
  files,
  onPick,
  onClose,
}: {
  repoId: string;
  files: GgufFile[];
  onPick: (file: GgufFile) => void;
  onClose: () => void;
}) {
  // Recommended quants first, then by size ascending.
  const sorted = [...files].sort(
    (a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false) || (a.size_bytes ?? 0) - (b.size_bytes ?? 0),
  );
  const list = useWindowedList(sorted.length, QUANT_VIEWPORT);
  const width = useShellWidth(72);

  const activate = () => {
    const f = sorted[list.index];
    if (f) {
      onPick(f);
      onClose();
    }
  };

  useModalKeys([
    { key: "escape", run: onClose },
    { key: "up", run: list.up },
    { key: "down", run: list.down },
    { key: "return", run: activate },
  ]);

  return (
    <ModalShell
      title={`Quants — ${fit(repoId, 30)}`}
      width={width}
      height={QUANT_VIEWPORT + 6}
      hints={[
        ["↑↓", "select"],
        ["enter", "download"],
      ]}
    >
      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        {sorted.slice(list.start, list.end).map((f, i) => {
          const idx = list.start + i;
          const selected = idx === list.index;
          return (
            <box key={f.filename} backgroundColor={selected ? theme.bg3 : undefined} onMouseDown={() => list.setIndex(idx)}>
              <text {...lift(selected)}>
                <span fg={selected ? theme.accent : theme.border}>{"▎"}</span>
                <span fg={selected ? theme.fg0 : theme.fg1}>{` ${fit(f.filename, 38)}`}</span>
                <span fg={theme.fg2}>{`  ${humanGb(f.size_gb ?? 0)}`}</span>
                {f.recommended ? <span fg={theme.success}>{"  ✓ rec"}</span> : null}
                {f.quality ? <span fg={theme.accentSoft}>{"  ★ qly"}</span> : null}
              </text>
            </box>
          );
        })}
      </box>
    </ModalShell>
  );
}

// ── GGUF download + auto-import ──────────────────────────────────────────────

/**
 * Stream a GGUF from HuggingFace (download.gguf → progress {pct,done,total}),
 * then auto-import it into Ollama (gguf.import) so it can be picked and run
 * like any local model — the Textual edition's touchless flow. Resolves with
 * {name} of the imported model.
 */
export function GgufDownloadModal({
  repoId,
  file,
  onClose,
}: {
  repoId: string;
  file: GgufFile;
  onClose: (value: { name?: string; cancelled?: boolean; error?: string }) => void;
}) {
  const bridge = useBridge();
  const [phase, setPhase] = useState<"download" | "import">("download");
  const [pct, setPct] = useState(0);
  const [status, setStatus] = useState("connecting…");
  const [error, setError] = useState("");
  const streamId = useRef<number | null>(null);
  const width = useShellWidth(60);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { id, done } = bridge.stream(
          "download.gguf",
          { repo_id: repoId, filename: file.filename, size_bytes: file.size_bytes ?? 0 },
          {
            onEvent: (event, data) => {
              if (event !== "progress" || !alive) return;
              setStatus(`${humanGb((data.done ?? 0) / 1e9)} of ${humanGb((data.total ?? 0) / 1e9)}`);
              if (data.pct != null) setPct(Math.min(100, data.pct));
            },
          },
        );
        streamId.current = id;
        const d = await done;
        if (!alive) return;
        setPct(100);
        setPhase("import");
        setStatus("importing into Ollama…");
        const imp = await bridge.request("gguf.import", { path: d.path });
        if (!alive) return;
        if (!imp.ok) {
          setError(imp.error || "import failed");
          setTimeout(() => onClose({ error: imp.error || "import failed" }), 1200);
          return;
        }
        setStatus(`ready as ${imp.name}`);
        setTimeout(() => onClose({ name: imp.name }), 500);
      } catch (e) {
        const msg = String((e as Error).message || e);
        if (alive) {
          setError(msg);
          setTimeout(() => onClose({ error: msg }), 1200);
        }
      }
    })();
    return () => {
      alive = false;
      if (streamId.current != null) bridge.cancel(streamId.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useModalKeys([
    { key: "escape", run: () => onClose({ cancelled: true }) },
    { key: "c", run: () => onClose({ cancelled: true }) },
  ]);

  return (
    <ModalShell title={`GGUF — ${fit(file.filename, 26)}`} width={width} hints={[["esc", "cancel"]]}>
      <box marginTop={1}>
        <text>
          {error ? (
            <span fg={theme.error}>✗</span>
          ) : phase === "import" ? (
            <Spinner color={theme.warn} />
          ) : (
            <Spinner color={theme.accent} />
          )}
          <span fg={theme.fg1}>{` ${error || status}`}</span>
        </text>
      </box>
      <box marginTop={1}>
        <text>
          <span fg={theme.accent}>{"━".repeat(Math.round((pct / 100) * (width - 6)))}</span>
          <span fg={track()}>{"━".repeat(width - 6 - Math.round((pct / 100) * (width - 6)))}</span>
          <span fg={theme.fg2}>{` ${Math.round(pct)}%`}</span>
        </text>
      </box>
      <box marginTop={1}>
        <text fg={theme.fg2}>
          {phase === "import" ? "Installing the chat template — one moment." : `${fit(repoId, width - 8)} — esc cancels.`}
        </text>
      </box>
    </ModalShell>
  );
}
