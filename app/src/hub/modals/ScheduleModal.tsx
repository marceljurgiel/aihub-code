// Ported from AIhub-TUI v1.5.0 app/src/modals/ScheduleModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import { singleLinePaste } from "../clipboard.ts";
import { theme, fit } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { ListRow } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList } from "./modalKit.ts";
import { formatSlot } from "../schedule/format.ts";
import type { CurrentModel, ScheduledTask } from "../schedule/types.ts";

type View = "list" | "name" | "agent" | "when" | "prompt";

interface AgentRow {
  name: string;
  description: string;
}

/** The task being written: the fields schedule.save takes. */
interface Draft {
  name: string;
  agent: string;
  model: string;
  backend: string;
  stream_model: string;
  when: string;
  prompt: string;
  enabled: boolean;
  created: string;
}

const VIEWPORT = 8;
export const ONLY_WHILE_OPEN = "Tasks run only while aihub-code is open.";
const WHEN_HINT = "every 30m · daily 08:00 · weekdays 08:00 · weekly Mon 08:00 · once 2026-10-08 10:00";

const statusText = (t: ScheduledTask) =>
  t.broken
    ? `broken: ${t.broken}`
    : t.last_status
      ? `${t.last_status}${t.last_run ? ` · ${formatSlot(t.last_run)}` : ""}`
      : "—";

/**
 * Scheduled tasks: an agent runs a prompt on a timetable (every 30m, daily
 * 08:00, …) — only while aihub-code is open; the chat's clock starts them. Each
 * run is saved to History; Enter opens the last one.
 */
export function ScheduleModal({
  onClose,
  running: runningNow,
  lastEnded = () => ({ name: "", n: 0 }),
  onRunNow,
  onCancelRun,
  onOpenSession,
  current,
}: {
  onClose: () => void;
  /** The task running right now, if any (read live: it changes while open). */
  running: () => string | null;
  /** The last run that ended, counted (read live). */
  lastEnded?: () => { name: string; n: number };
  onRunNow: (name: string) => void;
  onCancelRun: () => void;
  onOpenSession: (s: { model: string; filename: string }) => void;
  current: CurrentModel;
}) {
  const bridge = useBridge();
  const term = useTerminalDimensions();
  const width = useShellWidth(Math.max(64, Math.min(110, term.width - 4)));
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [running, setRunning] = useState<string | null>(runningNow());
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("list");
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const original = useRef<string | null>(null);
  const inputEl = useRef<any>(null);
  const promptEl = useRef<TextareaRenderable | null>(null);
  const lastSubmit = useRef(0);
  const list = useWindowedList(tasks.length, VIEWPORT);
  const agentList = useWindowedList(agents.length, VIEWPORT);
  const selected = tasks[list.index] ?? null;
  const fail = (e: unknown) => setNote(String((e as Error)?.message || e));

  const refresh = () =>
    bridge
      .request("schedule.list")
      .then((d) => setTasks(d.tasks || []))
      .catch(fail)
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
  }, []);

  // Follow the scheduler: show a task as running, and its result once it ends.
  const runningRef = useRef<string | null>(running);
  const endedSeen = useRef(lastEnded().n);
  useEffect(() => {
    const t = setInterval(() => {
      const now = runningNow();
      const ended = lastEnded();
      if (runningRef.current === now && endedSeen.current === ended.n) return;
      runningRef.current = now;
      setRunning(now);
      void refresh();
      if (endedSeen.current !== ended.n) {
        endedSeen.current = ended.n;
        // "Running X…" mustn't outlive the run, even one that ended at once.
        setNote((n) => (n === `Running ${ended.name}…` ? `${ended.name} finished — ↵ shows the result.` : n));
      }
    }, 250);
    return () => clearInterval(t);
  }, []);

  // Text fields start with the draft's value (edit) — set after they mount.
  useEffect(() => {
    if (!draft) return;
    if (view === "name" || view === "when") {
      const v = view === "name" ? draft.name : draft.when;
      setTimeout(() => inputEl.current && (inputEl.current.value = v), 0);
    } else if (view === "prompt") {
      setTimeout(() => promptEl.current?.setText(draft.prompt), 0);
    }
  }, [view]);

  // Enter reaches both the modal keymap and the input: act once.
  const submitted = () => {
    if (Date.now() - lastSubmit.current < 200) return false;
    lastSubmit.current = Date.now();
    return true;
  };
  const value = (v?: string) => String(v ?? inputEl.current?.value ?? "").trim();
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const startForm = (task: ScheduledTask | null) => {
    original.current = task?.name ?? null;
    setDraft(
      task
        ? { name: task.name, agent: task.agent, model: task.model, backend: task.backend,
            stream_model: task.stream_model, when: task.when, prompt: task.prompt,
            enabled: task.enabled, created: task.created }
        : { name: "", agent: "", model: current.model, backend: current.backend,
            stream_model: current.streamModel || current.model, when: "", prompt: "",
            enabled: true, created: "" },
    );
    setNote("");
    setArmed(null);
    setView("name");
    bridge
      .request("agents.list")
      .then((d) => {
        const rows: AgentRow[] = (d.agents || []).map((a: any) => ({ name: a.name, description: a.description || "" }));
        setAgents(rows);
        const at = rows.findIndex((a) => a.name === task?.agent);
        agentList.setIndex(Math.max(0, at));
      })
      .catch(fail);
  };

  const submitName = (v?: string) => {
    if (!submitted()) return;
    const n = value(v).toLowerCase();
    if (!n) return;
    patch({ name: n });
    setNote("");
    setView("agent");
  };

  const pickAgent = () => {
    // No text field here, so no double Enter to swallow (and the step can be
    // passed quickly right after the name).
    const a = agents[agentList.index];
    if (!a) return;
    patch({ agent: a.name });
    setView("when");
  };

  const submitWhen = (v?: string) => {
    if (!submitted()) return;
    const w = value(v);
    if (!w) return;
    patch({ when: w });
    setView("prompt");
  };

  const save = () => {
    if (!draft) return;
    const task = { ...draft, prompt: promptEl.current ? promptEl.current.plainText : draft.prompt };
    patch({ prompt: task.prompt });
    const params: Record<string, unknown> = { task };
    if (original.current) params.original_name = original.current;
    bridge
      .request("schedule.save", params)
      .then((d) => {
        setNote(`Saved ${d.task?.name ?? task.name}.`);
        setDraft(null);
        setView("list");
        void refresh();
      })
      .catch(fail);
  };

  const toggle = () => {
    if (!selected || selected.broken) return;
    bridge
      .request("schedule.toggle", { name: selected.name, enabled: !selected.enabled })
      .then(() => refresh())
      .catch(fail);
  };

  const run = () => {
    if (!selected || selected.broken) return;
    if (running === selected.name) {
      onCancelRun();
      return setNote(`Cancelled task ${selected.name}.`);
    }
    onRunNow(selected.name);
    setNote(running ? `${selected.name} runs after ${running}.` : `Running ${selected.name}…`);
  };

  const remove = () => {
    if (!selected) return;
    if (armed !== selected.name) {
      setArmed(selected.name);
      return setNote(`Press d again to delete ${selected.name}.`);
    }
    bridge
      .request("schedule.delete", { name: selected.name })
      .then(() => (setArmed(null), setNote(`Deleted ${selected.name}.`), refresh()))
      .catch(fail);
  };

  const openLast = () => {
    if (!selected) return;
    if (!selected.last_session) return setNote("No run yet.");
    onOpenSession(selected.last_session);
    onClose();
  };

  const back = () => {
    setNote("");
    setArmed(null);
    const steps: View[] = ["list", "name", "agent", "when", "prompt"];
    if (view === "list") return onClose();
    if (view === "prompt" && promptEl.current) patch({ prompt: promptEl.current.plainText });
    if (view === "name") setDraft(null);
    setView(steps[steps.indexOf(view) - 1]!);
  };

  const typing = view === "name" || view === "when" || view === "prompt";
  useModalKeys([
    { key: "escape", run: back },
    { key: "ctrl+s", run: () => view === "prompt" && save() },
  ]);
  // Enter belongs to the textarea in the prompt step (a new line).
  useModalKeys(
    [
      {
        key: "return",
        run: () =>
          view === "list" ? openLast() : view === "name" ? submitName() : view === "agent" ? pickAgent() : view === "when" ? submitWhen() : undefined,
      },
    ],
    { enabled: () => view !== "prompt" },
  );
  useModalKeys(
    [
      { key: "up", run: () => (view === "list" ? list.up() : agentList.up()) },
      { key: "down", run: () => (view === "list" ? list.down() : agentList.down()) },
      { key: "n", run: () => view === "list" && startForm(null) },
      { key: "e", run: () => view === "list" && selected && !selected.broken && startForm(selected) },
      { key: "space", run: () => view === "list" && toggle() },
      { key: "r", run: () => view === "list" && run() },
      { key: "d", run: () => view === "list" && remove() },
      {
        key: "m",
        run: () =>
          view === "agent" &&
          patch({ model: current.model, backend: current.backend, stream_model: current.streamModel || current.model }),
      },
    ],
    { enabled: () => !typing },
  );

  const hints: Array<[string, string]> =
    view === "list"
      ? [["n", "new"], ["e", "edit"], ["space", "on/off"], ["r", running && selected?.name === running ? "cancel" : "run"], ["↵", "result"], ["d", "delete"]]
      : view === "agent"
        ? [["↑↓", "pick"], ["enter", "next"], ["m", "use current model"], ["esc", "back"]]
        : view === "prompt"
          ? [["^S", "save"], ["esc", "back"]]
          : [["enter", "next"], ["esc", "back"]];

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

  const preview = selected
    ? selected.broken
      ? `  ${selected.path}: ${selected.broken}`
      : selected.last_status === "error"
        ? `  Last run failed: ${selected.last_error || "unknown error"}`
        : selected.last_summary
          ? `  Last result: ${selected.last_summary}`
          : `  ${selected.agent} · ${selected.model} — “${selected.prompt.replace(/\s+/g, " ")}”`
    : "";

  return (
    <ModalShell title="Schedule" width={width} height={VIEWPORT + 15} hints={hints}>
      {view === "list" ? (
        <box key="list" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexDirection="column" height={VIEWPORT} flexShrink={0}>
            {loading ? (
              <text fg={theme.fg2}>{"  Loading tasks…"}</text>
            ) : tasks.length === 0 ? (
              <text fg={theme.fg2} wrapMode="word">
                {"  No scheduled tasks yet. A task runs an agent with your prompt on a timetable — say, a summary of new email every morning. Press n to make one."}
              </text>
            ) : (
              tasks.slice(list.start, list.end).map((t, i) => {
                const idx = list.start + i;
                const sel = idx === list.index;
                const isRunning = running === t.name;
                const next = t.broken ? "" : !t.enabled ? "(off)" : t.next_run ? `next ${formatSlot(t.next_run)}` : "—";
                return (
                  <ListRow key={t.name} selected={sel} onSelect={() => list.setIndex(idx)}>
                    <text>
                      <span fg={t.enabled && !t.broken ? theme.success : theme.fg2}>{t.enabled && !t.broken ? " [✓] " : " [ ] "}</span>
                      <span fg={sel ? theme.fg0 : theme.fg1}>{fit(t.name, 18).padEnd(19)}</span>
                      <span fg={theme.fg2}>{fit(t.when, 18).padEnd(19)}</span>
                      <span fg={theme.fg2}>{fit(isRunning ? "► running…" : next, 24).padEnd(25)}</span>
                      <span fg={t.broken || t.last_status === "error" ? theme.error : theme.fg2}>
                        {fit(statusText(t), Math.max(10, width - 74))}
                      </span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          <box flexDirection="column" flexShrink={0} marginTop={1}>
            <text fg={selected?.last_status === "error" || selected?.broken ? theme.warn : theme.fg1}>
              {fit(preview, (width - 6) * 2)}
            </text>
            <text fg={theme.fg2}>{`  ${ONLY_WHILE_OPEN} Each run is saved to History.`}</text>
          </box>
        </box>
      ) : view === "name" ? (
        <box key="name" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>{"  Task name (lowercase, e.g. mail-digest):"}</text>
          {input("name", submitName)}
        </box>
      ) : view === "agent" && draft ? (
        <box key="agent" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>{`  Which agent runs it? It works with that agent's tools and permissions.`}</text>
          <text fg={theme.fg2}>
            {fit(`  model: ${draft.model || "none"}${draft.model === current.model ? " (current)" : ` — m uses the current one (${current.model || "none"})`}`, width - 6)}
          </text>
          <box flexDirection="column" height={VIEWPORT} flexShrink={0} marginTop={1}>
            {agents.length === 0 ? (
              <text fg={theme.fg2}>{"  Loading agents…"}</text>
            ) : (
              agents.slice(agentList.start, agentList.end).map((a, i) => {
                const idx = agentList.start + i;
                const sel = idx === agentList.index;
                return (
                  <ListRow key={a.name} selected={sel} onSelect={() => agentList.setIndex(idx)}>
                    <text>
                      <span fg={sel ? theme.fg0 : theme.fg1}>{` ${fit(a.name, 16).padEnd(17)}`}</span>
                      <span fg={theme.fg2}>{fit(a.description, width - 26)}</span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          <text fg={theme.fg2}>{"  Tools that need your OK are refused when nobody is there to answer."}</text>
        </box>
      ) : view === "when" ? (
        <box key="when" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>{"  When? Local time."}</text>
          <text fg={theme.fg2}>{fit(`  ${WHEN_HINT}`, width - 6)}</text>
          {input("daily 08:00", submitWhen)}
          <text fg={theme.fg2}>{`  ${ONLY_WHILE_OPEN} Missed while closed? AIhub asks when it starts.`}</text>
        </box>
      ) : view === "prompt" && draft ? (
        <box key="prompt" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg1}>{`  What should ${draft.agent} do? (${draft.when})`}</text>
          <box flexGrow={1} border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.bg2} marginTop={1} paddingLeft={1} paddingRight={1}>
            <textarea
              ref={promptEl}
              focused
              backgroundColor={theme.bg2}
              textColor={theme.fg0}
              placeholderColor={theme.fg2}
              cursorColor={theme.accent}
              placeholder={"e.g. Summarize today's unread email in 5 bullets."}
            />
          </box>
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
