// Ported from AIhub-TUI v1.5.0 app/src/modals/KnowledgeModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { singleLinePaste } from "../clipboard.ts";
import { theme, fit } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { ListRow, Meter, Spinner } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList } from "./modalKit.ts";

export interface KnowledgeBase {
  name: string;
  description: string;
  model: string;
  sources: string[];
  files: number;
  chunks: number;
  bytes: number;
  updated: number;
}

interface Embedder {
  reachable: boolean;
  ready: boolean;
  url: string;
  model: string;
}

interface Hit {
  base: string;
  source: string;
  page: number | null;
  title: string;
  text: string;
  score: number;
}

/** What an indexing run reports as it goes. */
interface Progress {
  files: number;
  i: number;
  n: number;
  path: string;
  done: number;
  total: number;
  problems: Array<{ path: string; error: string }>;
  result: any;
}

type View = "list" | "name" | "describe" | "add" | "index" | "search" | "sources" | "pull";

const VIEWPORT = 8;

const human = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

/** Paths as typed, pasted or dropped: quoted, backslash-escaped, file://. */
export function splitPaths(text: string): string[] {
  const parts = text.trim().match(/'[^']+'|"[^"]+"|(?:\\ |\S)+/g) ?? [];
  return parts
    .map((p) => p.replace(/^['"]|['"]$/g, "").replace(/\\ /g, " "))
    .map((p) => (p.startsWith("file://") ? decodeURIComponent(p.slice(7)).replace(/^\/([A-Za-z]:)/, "$1") : p))
    .filter(Boolean);
}

/**
 * Knowledge bases — your documents, searchable by meaning. Create one, add
 * files or folders (text, code, PDF, Word), and attach it to an agent (Agents
 * → k) or to a chat (/kb <name>). Embeddings come from Ollama
 * (EmbeddingGemma); when the model is missing, this window downloads it.
 */
export function KnowledgeModal({ onClose }: { onClose: () => void }) {
  const bridge = useBridge();
  const term = useTerminalDimensions();
  const width = useShellWidth(Math.max(60, Math.min(104, term.width - 4)));
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [embedder, setEmbedder] = useState<Embedder | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("list");
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [target, setTarget] = useState("");                 // the base being added to / searched
  const [progress, setProgress] = useState<Progress | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [pull, setPull] = useState<{ status: string; completed: number; total: number; error: string } | null>(null);
  const draftName = useRef("");
  const afterPull = useRef<(() => void) | null>(null);
  const streamId = useRef<number | null>(null);
  const inputEl = useRef<any>(null);
  const lastSubmit = useRef(0);
  const list = useWindowedList(bases.length, VIEWPORT);
  const selected = bases[list.index] ?? null;
  const sources = useWindowedList(selected?.sources.length ?? 0, VIEWPORT + 3);

  const refresh = () =>
    Promise.all([bridge.request("kb.list"), bridge.request("kb.status").catch(() => null)])
      .then(([l, st]) => {
        setBases(l.bases || []);
        setEmbedder(st);
      })
      .catch((e) => setNote(String((e as Error).message || e)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
  }, []);

  const input = (placeholder: string, onSubmit: (v: string) => void) => (
    <box border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.bg2} flexShrink={0} paddingLeft={1} marginTop={1}>
      <input
        ref={inputEl}
        onPaste={singleLinePaste}
        focused
        placeholder={placeholder}
        onSubmit={(v: unknown) => onSubmit(typeof v === "string" ? v : String(inputEl.current?.value ?? ""))}
        backgroundColor={theme.bg2}
        textColor={theme.fg0}
        placeholderColor={theme.fg2}
        cursorColor={theme.accent}
      />
    </box>
  );

  // Enter reaches both the modal keymap and the input: act once.
  const submitted = () => {
    if (Date.now() - lastSubmit.current < 200) return false;
    lastSubmit.current = Date.now();
    return true;
  };
  const value = (v?: string) => String(v ?? inputEl.current?.value ?? "").trim();

  /** Run `then` once the embedding model is there — downloading it first
   *  (with the user's go-ahead: they pressed the key that leads here). */
  const withEmbedder = (then: () => void) => {
    bridge
      .request("kb.status")
      .then((st: Embedder) => {
        setEmbedder(st);
        if (st.ready) return then();
        if (!st.reachable) return setNote(`Can't reach Ollama at ${st.url} — check Settings.`);
        afterPull.current = then;
        setPull(null);
        setView("pull");
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const startPull = () => {
    setPull({ status: "starting…", completed: 0, total: 0, error: "" });
    const s = bridge.stream("kb.pull", {}, {
      onEvent: (event: string, d: any) => {
        if (event === "progress") setPull({ status: d.status, completed: d.completed || 0, total: d.total || 0, error: "" });
      },
    });
    streamId.current = s.id;
    s.done
      .then((d: any) => {
        streamId.current = null;
        if (d?.cancelled) return setView("list");
        void refresh();
        const next = afterPull.current;
        afterPull.current = null;
        if (next) next();
        else setView("list");
      })
      .catch((e) => {
        streamId.current = null;
        setPull((p) => ({ status: "", completed: 0, total: 0, ...(p || {}), error: String((e as Error).message || e) }));
      });
  };

  const index = (name: string, paths: string[] | null) => {
    setTarget(name);
    setProgress({ files: 0, i: 0, n: 0, path: "", done: 0, total: 0, problems: [], result: null });
    setView("index");
    const patch = (p: Partial<Progress>) => setProgress((x) => (x ? { ...x, ...p } : x));
    const s = bridge.stream(paths ? "kb.add" : "kb.sync", paths ? { name, paths } : { name }, {
      onEvent: (event: string, d: any) => {
        if (event === "scan") patch({ files: d.files });
        else if (event === "file") patch({ i: d.i, n: d.n, path: d.path, done: 0, total: d.chunks });
        else if (event === "embed") patch({ done: d.done, total: d.total });
        else if (event === "problem") setProgress((x) => (x ? { ...x, problems: [...x.problems, d] } : x));
      },
    });
    streamId.current = s.id;
    s.done
      .then((d: any) => {
        streamId.current = null;
        patch({ result: d, problems: d.problems || [] });
        void refresh();
      })
      .catch((e) => {
        streamId.current = null;
        patch({ result: { error: String((e as Error).message || e) } });
      });
  };

  const submitName = (v?: string) => {
    if (!submitted()) return;
    const n = value(v).toLowerCase();
    if (!n) return;
    draftName.current = n;
    setNote("");
    setView("describe");
    setTimeout(() => inputEl.current && (inputEl.current.value = ""), 0);
  };

  const submitDescription = (v?: string) => {
    if (!submitted()) return;
    bridge
      .request("kb.create", { name: draftName.current, description: value(v) })
      .then((b: KnowledgeBase) => {
        void refresh();
        setTarget(b.name);
        withEmbedder(() => setView("add"));
      })
      .catch((e) => (setNote(String((e as Error).message || e)), setView("name")));
  };

  const submitPaths = (v?: string) => {
    if (!submitted()) return;
    const paths = splitPaths(value(v));
    if (!paths.length) return;
    index(target, paths);
  };

  const submitSearch = (v?: string) => {
    if (!submitted()) return;
    const q = value(v);
    if (!q) return;
    setNote("searching…");
    bridge
      .request("kb.search", { name: target, query: q, k: 5 })
      .then((d) => (setHits(d.hits || []), setNote(d.hits?.length ? "" : "No matches.")))
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const remove = () => {
    if (!selected) return;
    if (armed !== selected.name) {
      setArmed(selected.name);
      return setNote(`Press d again to delete ${selected.name} (your files stay; only the index goes).`);
    }
    bridge
      .request("kb.delete", { name: selected.name })
      .then(() => (setArmed(null), setNote(`Deleted ${selected.name}.`), refresh()))
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const removeSource = () => {
    const src = selected?.sources[sources.index];
    if (!selected || !src) return;
    if (armed !== src) {
      setArmed(src);
      return setNote("Press r again to remove this source from the base.");
    }
    setArmed(null);
    bridge
      .request("kb.remove_source", { name: selected.name, source: src })
      .then(() => (setNote("Removed."), refresh()))
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const typing = ["name", "describe", "add", "search"].includes(view);
  const back = () => {
    setNote("");
    setArmed(null);
    if (view === "list") return onClose();
    if ((view === "index" || view === "pull") && streamId.current != null) {
      bridge.cancel(streamId.current);
      streamId.current = null;
    }
    setHits([]);
    setView("list");
  };

  useModalKeys([
    { key: "escape", run: back },
    { key: "up", run: () => (view === "list" ? list.up() : view === "sources" ? sources.up() : undefined) },
    { key: "down", run: () => (view === "list" ? list.down() : view === "sources" ? sources.down() : undefined) },
    {
      key: "return",
      run: () =>
        view === "list"
          ? selected && setView("sources")
          : view === "name"
            ? submitName()
            : view === "describe"
              ? submitDescription()
              : view === "add"
                ? submitPaths()
                : view === "search"
                  ? submitSearch()
                  : view === "pull"
                    ? !pull || pull.error ? startPull() : undefined
                    : view === "index" && progress?.result
                      ? back()
                      : undefined,
    },
  ]);
  useModalKeys(
    [
      { key: "n", run: () => view === "list" && (setNote(""), setView("name")) },
      { key: "a", run: () => view === "list" && selected && (setTarget(selected.name), withEmbedder(() => setView("add"))) },
      { key: "s", run: () => view === "list" && selected && withEmbedder(() => index(selected.name, null)) },
      { key: "/", run: () => view === "list" && selected && (setTarget(selected.name), setHits([]), withEmbedder(() => setView("search"))) },
      { key: "d", run: () => view === "list" && remove() },
      { key: "m", run: () => view === "list" && embedder && !embedder.ready && withEmbedder(() => setView("list")) },
      { key: "r", run: () => view === "sources" && removeSource() },
    ],
    { enabled: () => !typing },
  );

  const hints: Array<[string, string]> =
    view === "list"
      ? [["n", "new"], ["a", "add files"], ["s", "sync"], ["/", "search"], ["↵", "sources"], ["d", "delete"]]
      : view === "sources"
        ? [["r", "remove source"], ["esc", "back"]]
        : view === "index"
          ? progress?.result
            ? [["enter", "done"]]
            : [["esc", "stop"]]
          : view === "pull"
            ? [["enter", pull && !pull.error ? "…" : "download"], ["esc", "not now"]]
            : [["enter", view === "search" ? "search" : "next"], ["esc", "back"]];

  const embedLine = embedder
    ? embedder.ready
      ? `  embeddings: ${embedder.model} on ${embedder.url}`
      : embedder.reachable
        ? `  ${embedder.model} isn't on ${embedder.url} yet — m downloads it (about 620 MB)`
        : `  can't reach Ollama at ${embedder.url} for embeddings`
    : "";

  return (
    <ModalShell title="Knowledge" width={width} height={VIEWPORT + 16} hints={hints}>
      {view === "list" ? (
        <box key="list" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexDirection="column" height={VIEWPORT} flexShrink={0}>
            {loading ? (
              <text fg={theme.fg2}>{"  loading…"}</text>
            ) : bases.length === 0 ? (
              <text fg={theme.fg2} wrapMode="word">
                {"  No knowledge bases yet. A knowledge base lets AIhub answer from your own documents — notes, manuals, code, PDFs, Word files. Press n to make one."}
              </text>
            ) : (
              bases.slice(list.start, list.end).map((b, i) => {
                const idx = list.start + i;
                const sel = idx === list.index;
                return (
                  <ListRow key={b.name} selected={sel} onSelect={() => list.setIndex(idx)}>
                    <text>
                      <span fg={sel ? theme.fg0 : theme.fg1}>{` ${fit(b.name, 16).padEnd(17)}`}</span>
                      <span fg={theme.fg2}>{`${b.files} files`.padEnd(10)}</span>
                      <span fg={theme.fg2}>{`${b.chunks} chunks`.padEnd(13)}</span>
                      <span fg={theme.fg2}>{human(b.bytes).padEnd(9)}</span>
                      <span fg={theme.fg2}>{fit(b.description, width - 56)}</span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          <box flexDirection="column" flexShrink={0} marginTop={1}>
            <text fg={embedder && !embedder.ready ? theme.warn : theme.fg2}>{fit(embedLine, width - 4)}</text>
            <text fg={theme.fg2}>{"  Use one in an agent (Agents → k) or in any chat: /kb <name>."}</text>
          </box>
        </box>
      ) : view === "name" || view === "describe" ? (
        <box key={view} flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>
            {view === "name"
              ? "  Name (lowercase, e.g. house, work-docs):"
              : `  What's in ${draftName.current}? One line — it helps the model pick the right base:`}
          </text>
          {input(view === "name" ? "name" : "e.g. manuals and notes for the house", view === "name" ? submitName : submitDescription)}
        </box>
      ) : view === "add" ? (
        <box key="add" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>{`  Add to ${target}: a folder or files — type, paste or drop them here.`}</text>
          <text fg={theme.fg2}>{"  Text and code, Markdown, PDF and Word (.docx). Folders are read with their subfolders."}</text>
          {input("~/Documents/notes  or  ~/manual.pdf", submitPaths)}
        </box>
      ) : view === "index" && progress ? (
        <box key="index" flexDirection="column" flexGrow={1} paddingTop={1}>
          {progress.result ? (
            progress.result.error ? (
              <text fg={theme.error} wrapMode="word">{`  ${progress.result.error}`}</text>
            ) : (
              <>
                <text fg={theme.success}>
                  {`  ✓ ${target}: ${progress.result.files} files, ${progress.result.chunks} chunks` +
                    (progress.result.changed ? ` (${progress.result.changed} read now)` : " (nothing changed)") +
                    (progress.result.cancelled ? " — stopped early" : "")}
                </text>
                <text fg={theme.fg1}>{`  Try it: / in the list, or /kb ${target} in a chat.`}</text>
              </>
            )
          ) : (
            <>
              <text fg={theme.fg0}>
                <Spinner color={theme.accent} />
                {progress.n ? ` Reading ${progress.i}/${progress.n}: ${fit(progress.path, width - 24)}` : ` Looking for files… ${progress.files || ""}`}
              </text>
              {progress.total ? (
                <box flexDirection="row">
                  <text>{"  "}</text>
                  <Meter fraction={progress.done / progress.total} width={30} color={theme.accent} />
                  <text fg={theme.fg2}>{`  ${progress.done}/${progress.total} chunks`}</text>
                </box>
              ) : null}
            </>
          )}
          {progress.problems.slice(-4).map((p) => (
            <text key={p.path} fg={theme.warn}>{fit(`  ! ${p.path}: ${p.error}`, width - 4)}</text>
          ))}
        </box>
      ) : view === "search" ? (
        <box key="search" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>{`  Search ${target} — what the model would get for this question:`}</text>
          {input("e.g. what pressure should the boiler have?", submitSearch)}
          {hits.slice(0, 4).map((h, i) => (
            <box key={i} flexDirection="column" marginTop={1}>
              <text>
                <span fg={theme.accentSoft}>{`  [${i + 1}] ${fit(h.title, width - 20)}`}</span>
                <span fg={theme.fg2}>{`  ${h.score.toFixed(2)}`}</span>
              </text>
              <text fg={theme.fg1}>{fit(`      ${h.text.replace(/\s+/g, " ")}`, (width - 6) * 2)}</text>
            </box>
          ))}
        </box>
      ) : view === "sources" && selected ? (
        <box key="sources" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg0}>{`  ${selected.name} — ${selected.description || "no description"}`}</text>
          <text fg={theme.fg2}>{`  ${selected.files} files · ${selected.chunks} chunks · ${selected.model}`}</text>
          <box flexDirection="column" height={VIEWPORT + 2} flexShrink={0} marginTop={1}>
            {selected.sources.length === 0 ? (
              <text fg={theme.fg2}>{"  No sources yet — esc, then a to add files."}</text>
            ) : (
              selected.sources.slice(sources.start, sources.end).map((s, i) => {
                const idx = sources.start + i;
                return (
                  <ListRow key={s} selected={idx === sources.index} onSelect={() => sources.setIndex(idx)}>
                    <text fg={idx === sources.index ? theme.fg0 : theme.fg1}>{fit(` ${s}`, width - 8)}</text>
                  </ListRow>
                );
              })
            )}
          </box>
        </box>
      ) : view === "pull" ? (
        <box key="pull" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg0} wrapMode="word">
            {`  Knowledge search needs the embedding model ${embedder?.model ?? "embeddinggemma"} on ${embedder?.url ?? "your Ollama"} (about 620 MB, once).`}
          </text>
          {!pull ? (
            <text fg={theme.fg1}>{"  Enter downloads it; then AIhub carries on."}</text>
          ) : pull.error ? (
            <text fg={theme.error} wrapMode="word">{`  ${pull.error} — enter tries again.`}</text>
          ) : (
            <>
              <text fg={theme.fg1}>
                <Spinner color={theme.accent} />
                {` ${pull.status}`}
              </text>
              {pull.total ? (
                <box flexDirection="row">
                  <text>{"  "}</text>
                  <Meter fraction={pull.completed / pull.total} width={40} color={theme.accent} />
                  <text fg={theme.fg2}>{`  ${human(pull.completed)} / ${human(pull.total)}`}</text>
                </box>
              ) : null}
            </>
          )}
        </box>
      ) : null}

      {note ? (
        <box flexShrink={0}>
          <text fg={theme.warn}>{fit(note, width - 6)}</text>
        </box>
      ) : null}
    </ModalShell>
  );
}
