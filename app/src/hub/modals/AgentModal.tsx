// Ported from AIhub-TUI v1.5.0 app/src/modals/AgentModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { singleLinePaste } from "../clipboard.ts";
import { theme, fit } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { ListRow, Spinner } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList } from "./modalKit.ts";

export interface AgentProfile {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  permission: "auto" | "ask";
  model: string;
  context: number;
  builtin: boolean;
  path: string;
}

export type AgentChoice =
  | { kind: "chat" }
  | { kind: "agent"; agent: AgentProfile; submode: "plan" | "build" };

/** Short labels for the tool list. */
const TOOL_LABEL: Record<string, string> = {
  read_file: "read",
  list_files: "ls",
  search_files: "grep",
  search_web: "web",
  remember: "memory",
  edit_file: "edit",
  write_file: "write",
  run_terminal: "shell",
};

export const toolsLabel = (tools: string[]) =>
  tools.filter((t) => !t.startsWith("kb:")).map((t) => TOOL_LABEL[t] ?? t).join(" ");
/** The knowledge bases an agent uses (its kb:<name> entries). */
export const knowledgeOf = (tools: string[]) => tools.filter((t) => t.startsWith("kb:")).map((t) => t.slice(3));

const VIEWPORT = 8;

/**
 * ^G — pick who you're talking to: plain chat or an agent (a role with its
 * own instructions, tools and permissions). `n` drafts a new agent from a
 * description with the current model; you review it before it's saved.
 */
export function AgentModal({
  current,
  model,
  backend,
  streamModel,
  onChoose,
  onClose,
}: {
  /** The active agent's name, or null in plain chat. */
  current: string | null;
  model: string | null;
  backend: string;
  streamModel: string;
  onChoose: (c: AgentChoice) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "new" | "review" | "kb">("list");
  // k: which knowledge bases the selected agent uses.
  const [kbBases, setKbBases] = useState<Array<{ name: string; description: string; files: number }>>([]);
  const [kbPicked, setKbPicked] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<AgentProfile | null>(null);
  const descEl = useRef<any>(null);
  // Enter reaches both the modal keymap and the input's onSubmit: draft once.
  const draftingRef = useRef(false);

  // Row 0 is plain chat; agents follow.
  const count = agents.length + 1;
  const list = useWindowedList(count, VIEWPORT);
  const selected: AgentProfile | null = list.index > 0 ? agents[list.index - 1] ?? null : null;

  const refresh = (select?: string) =>
    bridge
      .request("agents.list")
      .then((d) => {
        const all: AgentProfile[] = d.agents || [];
        setAgents(all);
        setDir(d.dir || "");
        const want = select ?? current;
        const i = want ? all.findIndex((a) => a.name === want) : -1;
        list.setIndex(i >= 0 ? i + 1 : 0);
      })
      .catch((e) => setNote(String((e as Error).message || e)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
  }, []);

  const choose = (submode: "plan" | "build") => {
    if (list.index === 0) onChoose({ kind: "chat" });
    else if (selected) onChoose({ kind: "agent", agent: selected, submode });
    onClose();
  };

  const del = () => {
    if (!selected) return;
    if (selected.builtin) return setNote(`${selected.name} is built in — it can't be deleted.`);
    if (armed !== selected.name) {
      setArmed(selected.name);
      return setNote(`Press d again to delete ${selected.path}.`);
    }
    bridge
      .request("agents.delete", { name: selected.name })
      .then(() => {
        setArmed(null);
        setNote(`Deleted ${selected.name}.`);
        void refresh("");
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const startNew = () => {
    if (!model) return setNote("Pick a model first (^O) — it writes the draft.");
    setNote("");
    setView("new");
  };

  const runDraft = (text?: string) => {
    const description = String(text ?? descEl.current?.value ?? "").trim();
    if (!description || draftingRef.current) return;
    draftingRef.current = true;
    setDrafting(true);
    setNote("");
    bridge
      .request("agents.draft", { description, model, backend, stream_model: streamModel })
      .then((d) => {
        setDraft(d.agent);
        setView("review");
      })
      .catch((e) => setNote(`Draft failed: ${(e as Error).message || e}`))
      .finally(() => {
        draftingRef.current = false;
        setDrafting(false);
      });
  };

  const saveDraft = () => {
    if (!draft) return;
    bridge
      .request("agents.save", { agent: draft })
      .then((d) => {
        setNote(`Saved ${d.agent.path} — edit it any time to fine-tune.`);
        setDraft(null);
        setView("list");
        void refresh(d.agent.name);
      })
      .catch((e) => setNote(`Not saved: ${(e as Error).message || e}`));
  };

  const kbList = useWindowedList(kbBases.length, VIEWPORT);
  const openKb = () => {
    if (!selected) return setNote("Pick an agent first (not plain chat).");
    setNote("");
    setKbPicked(knowledgeOf(selected.tools));
    kbList.setIndex(0);
    setView("kb");
    bridge
      .request("kb.list")
      .then((d) => setKbBases(d.bases || []))
      .catch((e) => setNote(String((e as Error).message || e)));
  };
  const toggleKb = () => {
    const b = kbBases[kbList.index];
    if (!b) return;
    setKbPicked((p) => (p.includes(b.name) ? p.filter((x) => x !== b.name) : [...p, b.name]));
  };
  const saveKb = () => {
    if (!selected) return;
    const tools = [...selected.tools.filter((t) => !t.startsWith("kb:")), ...kbPicked.map((n) => `kb:${n}`)];
    bridge
      .request("agents.save", { agent: { ...selected, tools } })
      .then((d) => {
        setNote(
          kbPicked.length
            ? `${d.agent.name} now answers from ${kbPicked.join(", ")} (and can search them).`
            : `${d.agent.name} uses no knowledge base.`,
        );
        setView("list");
        void refresh(d.agent.name);
      })
      .catch((e) => setNote(`Not saved: ${(e as Error).message || e}`));
  };

  const toggleDraftPermission = () =>
    setDraft((d) => (d ? { ...d, permission: d.permission === "auto" ? "ask" : "auto" } : d));

  const back = () => {
    if (view === "list") return onClose();
    setDraft(null);
    setNote("");
    setView("list");
  };

  useModalKeys([
    { key: "escape", run: back },
    { key: "up", run: () => (view === "list" ? list.up() : view === "kb" ? kbList.up() : undefined) },
    { key: "down", run: () => (view === "list" ? list.down() : view === "kb" ? kbList.down() : undefined) },
    {
      key: "return",
      run: () =>
        view === "list" ? choose("build") : view === "review" ? saveDraft() : view === "kb" ? saveKb() : runDraft(),
    },
  ]);
  // Letter keys only outside the description field.
  useModalKeys(
    [
      { key: "p", run: () => (view === "list" ? choose("plan") : undefined) },
      { key: "n", run: () => (view === "list" ? startNew() : undefined) },
      { key: "d", run: () => (view === "list" ? del() : undefined) },
      { key: "a", run: () => (view === "review" ? toggleDraftPermission() : undefined) },
      { key: "k", run: () => (view === "list" ? openKb() : undefined) },
      { key: "t", run: () => (view === "kb" ? toggleKb() : undefined) },
    ],
    { enabled: () => view !== "new" },
  );

  const term = useTerminalDimensions();
  const width = useShellWidth(Math.max(60, Math.min(84, term.width - 4)));
  const hints: Array<[string, string]> =
    view === "list"
      ? [["enter", "use"], ["p", "plan mode"], ["k", "knowledge"], ["n", "new agent"], ["d", "delete"]]
      : view === "kb"
        ? [["↑↓", "select"], ["t", "on/off"], ["enter", "save"], ["esc", "back"]]
      : view === "new"
        ? [["enter", "draft"], ["esc", "back"]]
        : [["enter", "save"], ["a", "auto/ask"], ["esc", "discard"]];

  return (
    <ModalShell title="Agents" width={width} height={VIEWPORT + 15} hints={hints}>
      {view === "list" ? (
        <box key="list" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexDirection="column" height={VIEWPORT} flexShrink={0}>
            {loading ? (
              <text fg={theme.fg2}>{"  loading…"}</text>
            ) : (
              [null, ...agents].slice(list.start, list.end).map((a, i) => {
                const idx = list.start + i;
                const sel = idx === list.index;
                const active = a ? a.name === current : current === null;
                return (
                  <ListRow key={a?.name ?? "__chat"} selected={sel} onSelect={() => list.setIndex(idx)}>
                    <text>
                      <span fg={active ? theme.accent : theme.fg2}>{active ? " [✓] " : " [ ] "}</span>
                      <span fg={sel ? theme.fg0 : theme.fg1}>{(a ? a.name : "chat").padEnd(14)}</span>
                      <span fg={a ? (a.permission === "auto" ? theme.warn : theme.success) : theme.fg2}>
                        {(a ? (a.permission === "auto" ? "auto" : "asks") : "").padEnd(6)}
                      </span>
                      <span fg={theme.fg2}>
                        {fit(a ? a.description : "Plain chat — no agent; tools only when you ask", width - 32)}
                      </span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          <box flexDirection="column" flexShrink={0} marginTop={1} height={5}>
            {selected ? (
              <>
                <text>
                  <span fg={theme.fg2}>{"  tools  "}</span>
                  <span fg={theme.fg1}>{fit(toolsLabel(selected.tools) || "none", width - 14)}</span>
                </text>
                <text>
                  <span fg={theme.fg2}>{"  knows  "}</span>
                  <span fg={knowledgeOf(selected.tools).length ? theme.accentSoft : theme.fg2}>
                    {fit(knowledgeOf(selected.tools).join(", ") || "no knowledge base — k adds one", width - 14)}
                  </span>
                </text>
                <text>
                  <span fg={theme.fg2}>{"  edits  "}</span>
                  <span fg={theme.fg1}>
                    {selected.permission === "auto"
                      ? "runs edits & commands without asking (Build); asks in Plan"
                      : "asks before every edit or command"}
                  </span>
                </text>
                <text>
                  <span fg={theme.fg2}>{"  model  "}</span>
                  <span fg={theme.fg1}>
                    {fit(
                      `${selected.model || "the current one"}${selected.context ? ` · max ${selected.context} ctx` : ""}`,
                      width - 14,
                    )}
                  </span>
                </text>
                <text fg={theme.fg2}>
                  {fit(`  ${selected.builtin ? "built in" : selected.path}`, width - 4)}
                </text>
              </>
            ) : (
              <text fg={theme.fg2}>
                {fit(`  Your agents live in ${dir || "~/.aihub/agents"} — n creates one.`, width - 4)}
              </text>
            )}
          </box>
        </box>
      ) : view === "kb" && selected ? (
        <box key="kb" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1} wrapMode="word">
            {`  What should ${selected.name} know? Its knowledge bases are searched before every answer, and it can search them itself.`}
          </text>
          <box flexDirection="column" height={VIEWPORT} flexShrink={0} marginTop={1}>
            {kbBases.length === 0 ? (
              <text fg={theme.fg2}>{"  No knowledge bases yet — make one in Knowledge (F6)."}</text>
            ) : (
              kbBases.slice(kbList.start, kbList.end).map((b, i) => {
                const idx = kbList.start + i;
                const on = kbPicked.includes(b.name);
                return (
                  <ListRow key={b.name} selected={idx === kbList.index} onSelect={() => kbList.setIndex(idx)}>
                    <text>
                      <span fg={on ? theme.success : theme.fg2}>{on ? " [✓] " : " [ ] "}</span>
                      <span fg={idx === kbList.index ? theme.fg0 : theme.fg1}>{fit(b.name, 18).padEnd(19)}</span>
                      <span fg={theme.fg2}>{fit(`${b.files} files · ${b.description}`, width - 34)}</span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
        </box>
      ) : view === "new" ? (
        <box key="new" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>{"  Describe the agent — what it does, what it may touch:"}</text>
          <text fg={theme.fg2}>{"  e.g. “checks my home server's disks and logs, never changes anything”"}</text>
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
              ref={descEl}
              onPaste={singleLinePaste}
              focused={!drafting}
              placeholder="what should this agent do?"
              onSubmit={(v: unknown) => runDraft(typeof v === "string" ? v : undefined)}
              backgroundColor={theme.bg2}
              textColor={theme.fg0}
              placeholderColor={theme.fg2}
              cursorColor={theme.accent}
            />
          </box>
          {drafting ? (
            <text fg={theme.fg2}>
              {"  "}
              <Spinner color={theme.fg2} />
              {` ${model} is drafting the agent…`}
            </text>
          ) : null}
        </box>
      ) : draft ? (
        <box key="review" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexShrink={0} height={1}>
            <text>
              <span fg={theme.fg2}>{"  name   "}</span>
              <span fg={theme.fg0}>{draft.name}</span>
              <span fg={theme.fg2}>{`   ${fit(draft.description, width - 24 - draft.name.length)}`}</span>
            </text>
          </box>
          <box flexShrink={0} height={1}>
            <text>
              <span fg={theme.fg2}>{"  tools  "}</span>
              <span fg={theme.fg1}>{toolsLabel(draft.tools) || "none"}</span>
            </text>
          </box>
          <box flexShrink={0} height={1}>
            <text>
              <span fg={theme.fg2}>{"  edits  "}</span>
              <span fg={draft.permission === "auto" ? theme.warn : theme.success}>
                {draft.permission === "auto" ? "auto — runs without asking" : "asks first"}
              </span>
            </text>
          </box>
          <scrollbox height={VIEWPORT + 2} flexShrink={0} marginTop={1} border borderStyle="rounded" borderColor={theme.border}>
            <text fg={theme.fg1} wrapMode="word">
              {draft.prompt}
            </text>
          </scrollbox>
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
