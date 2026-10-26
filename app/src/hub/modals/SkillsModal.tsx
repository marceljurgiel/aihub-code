// Ported from AIhub-TUI v1.5.0 app/src/modals/SkillsModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { singleLinePaste } from "../clipboard.ts";
import { theme, fit } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { ListRow, Spinner } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList } from "./modalKit.ts";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: "builtin" | "user" | "project";
  files: string[];
  enabled: boolean;
  body?: string;
}

interface Draft {
  name: string;
  description: string;
  instructions: string;
}

type View = "list" | "view" | "new" | "review" | "install" | "search" | "remote";

/** A result from the online directories (skills.sh, SkillsMP). */
interface HubSkill {
  name: string;
  repo: string;
  description: string;
  installs: number;
  stars: number;
  url: string;
  page: string;
  directory: string;
  installed: boolean;
}

interface Preview {
  name: string;
  description: string;
  body: string;
  repo: string;
  folder: string;
  files: string[];
  scripts: string[];
  size: number;
  source_url: string;
}

const kNum = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const VIEWPORT = 8;

/**
 * Skills (F4, /skills): saved instructions the model loads when a task
 * matches. enter puts `/skill <name> ` in the prompt; the model can also
 * pick a skill itself (use_skill). Skills use Anthropic's SKILL.md format,
 * so ones from GitHub install as-is.
 */
export function SkillsModal({
  model,
  backend,
  streamModel,
  onUse,
  onChanged,
  onClose,
}: {
  model: string | null;
  backend: string;
  streamModel: string;
  /** Prefill the chat prompt with `/skill <name> `. */
  onUse: (name: string) => void;
  /** The skill list changed (slash suggestions follow). */
  onChanged: (skills: SkillInfo[]) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const term = useTerminalDimensions();
  const width = useShellWidth(Math.max(60, Math.min(100, term.width - 4)));
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  const [shown, setShown] = useState<SkillInfo | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const inputEl = useRef<any>(null);
  const scrollEl = useRef<any>(null);
  const busyRef = useRef(false);
  const list = useWindowedList(skills.length, VIEWPORT);
  // Online search
  const [results, setResults] = useState<HubSkill[]>([]);
  const [searched, setSearched] = useState("");
  const [remote, setRemote] = useState<{ hit: HubSkill; preview: Preview } | null>(null);
  const hits = useWindowedList(results.length, VIEWPORT - 3);
  const hit = results[hits.index] ?? null;
  const selected = skills[list.index] ?? null;

  const refresh = (select?: string) =>
    bridge
      .request("skills.list")
      .then((d) => {
        const all: SkillInfo[] = d.skills || [];
        setSkills(all);
        setDir(d.dir || "");
        onChanged(all);
        if (select) {
          const i = all.findIndex((s) => s.name === select);
          if (i >= 0) list.setIndex(i);
        }
      })
      .catch((e) => setNote(String((e as Error).message || e)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
  }, []);

  /** Run one engine call with a spinner; a second Enter while busy is ignored. */
  const run = (label: string, p: Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setNote("");
    p.catch((e) => setNote(String((e as Error).message || e))).finally(() => {
      busyRef.current = false;
      setBusy("");
    });
  };

  const use = () => {
    if (!selected) return;
    if (!selected.enabled) return setNote(`${selected.name} is off — t turns it on.`);
    onUse(selected.name);
    onClose();
  };

  const toggle = () => {
    if (!selected) return;
    const enabled = !selected.enabled;
    bridge
      .request("skills.enable", { name: selected.name, enabled })
      .then(() => refresh(selected.name))
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const show = () => {
    if (!selected) return;
    bridge
      .request("skills.get", { name: selected.name })
      .then((d) => {
        setShown(d.skill);
        setView("view");
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const del = () => {
    if (!selected) return;
    if (selected.source !== "user")
      return setNote(`${selected.name} is ${selected.source === "builtin" ? "built in" : "from the project"} — turn it off with t instead.`);
    if (armed !== selected.name) {
      setArmed(selected.name);
      return setNote(`Press d again to delete ${selected.path}.`);
    }
    bridge
      .request("skills.delete", { name: selected.name })
      .then(() => {
        setArmed(null);
        setNote(`Deleted ${selected.name}.`);
        void refresh();
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const open = (v: View) => {
    if (v === "new" && !model) return setNote("Pick a model first (^O) — it writes the draft.");
    setNote("");
    setView(v);
  };

  const searchOnline = (q: string) =>
    run(
      "searching skills.sh and SkillsMP…",
      bridge.request("skills.search", { query: q, limit: 25 }).then((d) => {
        setResults(d.results || []);
        setSearched(q);
        hits.setIndex(0);
        const errs = Object.entries(d.errors || {}).map(([k, v]) => `${k}: ${v}`);
        if (errs.length) setNote(errs.join(" · "));
        else if (!(d.results || []).length) setNote(`Nothing found for “${q}”.`);
      }),
    );

  const previewHit = () => {
    if (!hit) return;
    run(
      `reading ${hit.repo}…`,
      bridge.request("skills.preview", { repo: hit.repo, name: hit.name, url: hit.url }).then((d) => {
        setRemote({ hit, preview: d.preview });
        setView("remote");
      }),
    );
  };

  const installRemote = () => {
    if (!remote) return;
    const { hit: h } = remote;
    run(
      `installing ${h.name}…`,
      bridge.request("skills.install_remote", { repo: h.repo, name: h.name, url: h.url }).then((d) => {
        setResults((rs) => rs.map((r) => (r === h ? { ...r, installed: true } : r)));
        setRemote(null);
        setView("list");
        void refresh(d.skill.name);
        setNote(`Installed ${d.skill.name} from ${h.repo} — v shows what it does.`);
      }),
    );
  };

  const submitInput = (text?: string) => {
    const value = String(text ?? inputEl.current?.value ?? "").trim();
    if (view === "search") {
      // A new query searches; enter on the same query opens the selected result.
      if (value && value !== searched) return searchOnline(value);
      return previewHit();
    }
    if (!value) return;
    if (view === "new")
      run(
        `${model} is drafting the skill…`,
        bridge
          .request("skills.draft", { description: value, model, backend, stream_model: streamModel })
          .then((d) => {
            setDraft(d.draft);
            setView("review");
          }),
      );
    else if (view === "install")
      run(
        "installing…",
        bridge.request("skills.install", { source: value }).then((d) => {
          const names = (d.installed || []).map((s: SkillInfo) => s.name);
          setView("list");
          void refresh(names[0]);
          setNote(`Installed ${names.join(", ")}.`);
        }),
      );
  };

  const saveDraft = () => {
    if (!draft) return;
    run(
      "saving…",
      bridge.request("skills.save", { ...draft }).then((d) => {
        setDraft(null);
        setView("list");
        void refresh(d.skill.name);
        setNote(`Saved ${d.skill.path}/SKILL.md — edit it any time.`);
      }),
    );
  };

  const back = () => {
    if (view === "list") return onClose();
    if (view === "remote") {
      setRemote(null);
      setNote("");
      return setView("search");
    }
    setDraft(null);
    setShown(null);
    setNote("");
    setView("list");
  };

  const scroll = (d: number) => {
    const sb = scrollEl.current;
    if (!sb) return;
    if (typeof sb.scrollBy === "function") sb.scrollBy(0, d);
    else sb.scrollTop = Math.max(0, (sb.scrollTop ?? 0) + d);
  };

  const typing = view === "new" || view === "install" || view === "search";
  useModalKeys([
    { key: "escape", run: back },
    { key: "up", run: () => (view === "list" ? list.up() : view === "search" ? hits.up() : scroll(-1)) },
    { key: "down", run: () => (view === "list" ? list.down() : view === "search" ? hits.down() : scroll(1)) },
    {
      key: "return",
      run: () =>
        view === "list"
          ? use()
          : view === "review"
            ? saveDraft()
            : view === "remote"
              ? installRemote()
              : typing
                ? submitInput()
                : back(),
    },
  ]);
  useModalKeys(
    [
      { key: "t", run: () => view === "list" && toggle() },
      { key: "v", run: () => view === "list" && show() },
      { key: "n", run: () => view === "list" && open("new") },
      { key: "i", run: () => view === "list" && open("install") },
      { key: "s", run: () => view === "list" && open("search") },
      { key: "d", run: () => view === "list" && del() },
    ],
    { enabled: () => !typing },
  );

  const hints: Array<[string, string]> =
    view === "list"
      ? [["↵", "use"], ["v", "view"], ["t", "on/off"], ["s", "search"], ["n", "new"], ["i", "link"], ["d", "del"]]
      : view === "search"
        ? [["enter", results.length ? "search / preview" : "search"], ["↑↓", "select"], ["esc", "back"]]
        : view === "remote"
          ? [["enter", "install"], ["↑↓", "scroll"], ["esc", "back"]]
      : view === "review"
        ? [["enter", "save"], ["↑↓", "scroll"], ["esc", "discard"]]
        : view === "view"
          ? [["↑↓", "scroll"], ["esc", "back"]]
          : [["enter", view === "new" ? "draft" : "install"], ["esc", "back"]];

  const SOURCE: Record<string, string> = { builtin: "built-in", user: "yours", project: "project" };

  return (
    <ModalShell title="Skills" width={width} height={VIEWPORT + 15} hints={hints}>
      {view === "list" ? (
        <box key="list" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexDirection="column" height={VIEWPORT} flexShrink={0}>
            {loading ? (
              <text fg={theme.fg2}>{"  loading…"}</text>
            ) : skills.length === 0 ? (
              <text fg={theme.fg2}>{"  No skills yet — n creates one, i installs from GitHub."}</text>
            ) : (
              skills.slice(list.start, list.end).map((s, i) => {
                const idx = list.start + i;
                const sel = idx === list.index;
                return (
                  <ListRow key={s.name} selected={sel} onSelect={() => list.setIndex(idx)}>
                    <text>
                      <span fg={s.enabled ? theme.success : theme.fg2}>{s.enabled ? " [✓] " : " [ ] "}</span>
                      <span fg={s.enabled ? (sel ? theme.fg0 : theme.fg1) : theme.fg2}>{fit(s.name, 18).padEnd(19)}</span>
                      <span fg={theme.fg2}>{SOURCE[s.source]!.padEnd(9)}</span>
                      <span fg={theme.fg2}>{fit(s.description, width - 40)}</span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          <box flexDirection="column" flexShrink={0} marginTop={1} height={4}>
            {selected ? (
              <>
                <text fg={theme.fg1} wrapMode="word">
                  {`  ${fit(selected.description, (width - 6) * 2)}`}
                </text>
                <text fg={theme.fg2}>
                  {fit(`  ${selected.path}${selected.files.length ? `  · +${selected.files.length} files` : ""}`, width - 4)}
                </text>
              </>
            ) : null}
            <text fg={theme.fg2}>
              {fit(`  The model loads a skill when a request matches it; enter uses one now.`, width - 4)}
            </text>
          </box>
        </box>
      ) : view === "view" && shown ? (
        <box key="view" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexShrink={0} height={1}>
            <text>
              <span fg={theme.fg0}>{`  ${shown.name}`}</span>
              <span fg={theme.fg2}>{`  ${fit(shown.path, width - 12 - shown.name.length)}`}</span>
            </text>
          </box>
          <scrollbox ref={scrollEl} height={VIEWPORT + 5} flexShrink={0} marginTop={1} border borderStyle="rounded" borderColor={theme.border}>
            <text fg={theme.fg1} wrapMode="word">
              {shown.body || "(no instructions)"}
            </text>
          </scrollbox>
        </box>
      ) : view === "search" ? (
        <box key="search" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.bg2} flexShrink={0} paddingLeft={1}>
            <input
              ref={inputEl}
              onPaste={singleLinePaste}
              focused={!busy}
              placeholder="search skills.sh + SkillsMP — e.g. pdf, git commit, docker"
              onSubmit={(v: unknown) => submitInput(typeof v === "string" ? v : undefined)}
              backgroundColor={theme.bg2}
              textColor={theme.fg0}
              placeholderColor={theme.fg2}
              cursorColor={theme.accent}
            />
          </box>
          <box flexDirection="column" height={VIEWPORT - 3} flexShrink={0} marginTop={1}>
            {busy ? (
              <text fg={theme.fg2}>
                {"  "}
                <Spinner color={theme.fg2} />
                {` ${busy}`}
              </text>
            ) : results.length === 0 ? (
              <text fg={theme.fg2}>{searched ? "  no results" : "  type what the skill should do and press enter"}</text>
            ) : (
              results.slice(hits.start, hits.end).map((r, i) => {
                const idx = hits.start + i;
                const sel = idx === hits.index;
                const pop = r.installs ? `${kNum(r.installs)} inst` : r.stars ? `★${kNum(r.stars)}` : "";
                return (
                  <ListRow key={`${r.repo}/${r.name}`} selected={sel} onSelect={() => hits.setIndex(idx)}>
                    <text>
                      <span fg={r.installed ? theme.success : theme.fg2}>{r.installed ? " ✓ " : "   "}</span>
                      <span fg={sel ? theme.fg0 : theme.fg1}>{fit(r.name, 22).padEnd(23)}</span>
                      <span fg={theme.fg2}>{fit(r.repo, 24).padEnd(25)}</span>
                      <span fg={theme.accentSoft}>{pop.padStart(10)}</span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          <box flexDirection="column" flexShrink={0} height={4}>
            {hit && !busy ? (
              <>
                <text fg={theme.fg1} wrapMode="word">
                  {`  ${fit(hit.description || "(no description in the directory — enter shows the skill)", (width - 6) * 2)}`}
                </text>
                <text fg={theme.fg2}>{fit(`  ${hit.directory} · ${hit.url || hit.page}`, width - 4)}</text>
              </>
            ) : null}
          </box>
        </box>
      ) : view === "remote" && remote ? (
        <box key="remote" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexShrink={0} height={1}>
            <text>
              <span fg={theme.fg0}>{`  ${remote.preview.name}`}</span>
              <span fg={theme.fg2}>{`  ${fit(remote.preview.source_url, width - 12 - remote.preview.name.length)}`}</span>
            </text>
          </box>
          <box flexShrink={0} height={1}>
            <text fg={remote.preview.scripts.length ? theme.warn : theme.fg2}>
              {fit(
                `  ${remote.preview.files.length + 1} files, ${Math.max(1, Math.round(remote.preview.size / 1024))} KB` +
                  (remote.preview.scripts.length
                    ? ` · ⚠ ${remote.preview.scripts.length} scripts the model may run (you approve commands in chat)`
                    : ""),
                width - 4,
              )}
            </text>
          </box>
          <scrollbox ref={scrollEl} height={VIEWPORT + 3} flexShrink={0} marginTop={1} border borderStyle="rounded" borderColor={theme.border}>
            <text fg={theme.fg1} wrapMode="word">
              {`${remote.preview.description}\n\n${remote.preview.body}`}
            </text>
          </scrollbox>
          {busy ? <text fg={theme.fg2}>{`  ${busy}`}</text> : null}
        </box>
      ) : typing ? (
        <box key={view} flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>
            {view === "new"
              ? "  Describe the skill — what task, what steps, what result:"
              : "  Install from a GitHub folder link, a git repo URL or a local folder:"}
          </text>
          <text fg={theme.fg2}>
            {fit(
              view === "new"
                ? "  e.g. “weekly report from my git commits, as a short Polish email”"
                : "  e.g. https://github.com/anthropics/skills/tree/main/skills/pdf",
              width - 4,
            )}
          </text>
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
              ref={inputEl}
              onPaste={singleLinePaste}
              focused={!busy}
              placeholder={view === "new" ? "what should this skill do?" : "link or path"}
              onSubmit={(v: unknown) => submitInput(typeof v === "string" ? v : undefined)}
              backgroundColor={theme.bg2}
              textColor={theme.fg0}
              placeholderColor={theme.fg2}
              cursorColor={theme.accent}
            />
          </box>
          {busy ? (
            <text fg={theme.fg2}>
              {"  "}
              <Spinner color={theme.fg2} />
              {` ${busy}`}
            </text>
          ) : null}
        </box>
      ) : view === "review" && draft ? (
        <box key="review" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexShrink={0} height={1}>
            <text>
              <span fg={theme.fg2}>{"  name  "}</span>
              <span fg={theme.fg0}>{draft.name}</span>
            </text>
          </box>
          <box flexShrink={0} height={2}>
            <text fg={theme.fg1} wrapMode="word">
              {`  ${draft.description}`}
            </text>
          </box>
          <scrollbox ref={scrollEl} height={VIEWPORT + 3} flexShrink={0} marginTop={1} border borderStyle="rounded" borderColor={theme.border}>
            <text fg={theme.fg1} wrapMode="word">
              {draft.instructions}
            </text>
          </scrollbox>
          {busy ? <text fg={theme.fg2}>{`  ${busy}`}</text> : null}
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
