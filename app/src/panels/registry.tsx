/** @jsxImportSource ../hub/jsx */
/**
 * Which AIhub window each panel is, and what it is given: the props v1.5.0's
 * ChatScreen passes (ChatScreen.tsx 868–1195), from the controller's state
 * (`session`, see session-adapter.ts) and the controller's methods.
 *
 * Callbacks for what the controller can't do yet write a note,
 * "<action> — coming in this release" (`soon`); Tasks 4–10 replace them with
 * controller methods. The task report lists every one.
 */
import type { ReactNode } from "react";
import type { ActionId } from "../hub/keymap/actions.ts";
import {
  AgentModal,
  HardwareModal,
  HelpModal,
  HistoryModal,
  KnowledgeModal,
  McpModal,
  MemoryModal,
  MissedTasksModal,
  ModelPickerModal,
  PaletteModal,
  ScheduleModal,
  SettingsModal,
  SkillsModal,
  TemperatureModal,
  ThemeModal,
} from "../hub/modals/index.ts";
import type { MissedTask } from "../hub/schedule/types.ts";
import type { Controller, PanelId } from "../session/controller";
import type { SessionLike } from "./session-adapter";

export interface PanelCtx {
  controller: Controller;
  session: SessionLike;
  arg?: string;
  /** The models window opened while a turn runs (the controller's panel.viewOnly). */
  viewOnly?: boolean;
}

export type PanelFactory = (close: (result?: string) => void) => ReactNode;

/** The stand-in for a controller method a later task adds. */
const soon = (c: Controller, action: string) => c.note(`${action} — coming in this release`);

/** The palette's AIhub actions, as aihub-code does them (hub/keymap/actions.ts
 *  lists only the ones it has). */
export function runAction(c: Controller, id: ActionId): void {
  const panel: Partial<Record<ActionId, PanelId>> = {
    agent: "agents",
    schedule: "schedule",
    skills: "skills",
    model_picker: "models",
    history: "history",
    memory: "memory",
    knowledge: "knowledge",
    mcp: "mcp",
    hardware: "hardware",
    settings: "settings",
    theme: "theme",
    temperature: "temperature",
    command_palette: "palette",
    help: "help",
  };
  const p = panel[id];
  if (p) return void c.openPanel(p);
  if (id === "new_chat") return void c.clear();
  if (id === "quit") return c.exit();
}

/** The missed-run panel's `arg`: the missed tasks as JSON (Task 9 opens it). */
function missedTasks(arg: string | undefined): MissedTask[] {
  try {
    const v = JSON.parse(arg ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function MissedPanel({ c, tasks, close }: { c: Controller; tasks: MissedTask[]; close: () => void }) {
  // One at a time, as AIhub asks them at start-up.
  const task = tasks[0] ?? { name: "", when: "", slot: "" };
  return (
    <MissedTasksModal
      task={task}
      index={0}
      total={Math.max(1, tasks.length)}
      onClose={(choice) => {
        soon(c, choice === "run" ? `Running the missed task ${task.name}` : `Skipping the missed task ${task.name}`);
        close();
      }}
    />
  );
}

export function panelFactory(id: PanelId, ctx: PanelCtx): PanelFactory {
  const { controller: c, session: s } = ctx;
  const streamModel = s.streamModel || s.modelName || "";
  switch (id) {
    case "memory":
      return (close) => <MemoryModal onClose={() => close()} />;
    case "models":
      return (close) => (
        <ModelPickerModal
          currentModel={s.modelName}
          installedSet={new Set<string>()}
          viewOnly={!!ctx.viewOnly}
          onPick={(name, backend, streamModel) => void c.useModel({ name, backend, streamModel })}
          onClose={() => close()}
        />
      );
    case "hardware":
      return (close) => <HardwareModal model={s.modelName} onClose={() => close()} />;
    case "agents":
      return (close) => (
        <AgentModal
          current={s.mode === "agent" ? s.agentName : null}
          model={s.modelName}
          backend={s.backend}
          streamModel={streamModel}
          onChoose={(choice) =>
            void c.setKind(choice.kind === "agent" ? { type: "agent", name: choice.agent.name, submode: choice.submode } : { type: "chat" })
          }
          onClose={() => close()}
        />
      );
    case "skills":
      return (close) => (
        <SkillsModal
          model={s.modelName}
          backend={s.backend}
          streamModel={streamModel}
          // The window closes itself after onUse; the prompt comes back with this.
          onUse={(name) => c.prefill(`/skill ${name} `)}
          // AIhub refreshes its `/skill <name>` suggestions here.
          onChanged={(all) => c.skillsChanged(all)}
          onClose={() => close()}
        />
      );
    case "mcp":
      return (close) => <McpModal onClose={() => close()} />;
    case "knowledge":
      return (close) => <KnowledgeModal onClose={() => close()} />;
    case "schedule":
      return (close) => (
        <ScheduleModal
          onClose={() => close()}
          running={() => null}
          onRunNow={(name) => soon(c, `Running the task ${name}`)}
          onCancelRun={() => soon(c, "Cancelling the running task")}
          onOpenSession={(sess) => soon(c, `Opening the task's session (${sess.filename})`)}
          current={{ model: s.modelName ?? "", backend: s.backend, streamModel }}
        />
      );
    case "missed":
      return (close) => <MissedPanel c={c} tasks={missedTasks(ctx.arg)} close={() => close()} />;
    case "history":
      return (close) => (
        <HistoryModal model={s.modelName} onLoad={(messages, startTime) => void c.loadHistory(messages, startTime)} onClose={() => close()} />
      );
    case "settings":
      return (close) => (
        <SettingsModal
          session={s}
          // Memory / tools are saved by the window itself (config.set); the
          // controller keeps no copy of them yet.
          onPatchSession={() => {}}
          onEngineChanged={(change) => {
            if (change.ollamaChanged) soon(c, "Checking the models on the new Ollama server");
          }}
          onTemperature={(t) => void c.setTemperature(t)}
          onClose={() => close()}
        />
      );
    case "theme":
      return (close) => <ThemeModal onSave={(name) => soon(c, `Saving the theme ${name}`)} onClose={() => close()} />;
    case "temperature":
      return (close) => (
        <TemperatureModal value={s.temperature} onSave={(t) => void c.setTemperature(t)} onClose={() => close()} />
      );
    case "palette":
      return (close) => <PaletteModal onAction={(action) => runAction(c, action)} onClose={() => close()} />;
    case "help":
      return (close) => <HelpModal onClose={() => close()} />;
  }
}

/** Every panel the registry knows (the tests walk it). */
export const PANEL_IDS: readonly PanelId[] = [
  "memory",
  "models",
  "hardware",
  "agents",
  "skills",
  "mcp",
  "knowledge",
  "schedule",
  "missed",
  "history",
  "settings",
  "theme",
  "temperature",
  "palette",
  "help",
];
