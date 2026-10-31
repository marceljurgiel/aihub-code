/**
 * The session controller: the one place that turns bridge events into
 * transcript lines (through a ScrollbackSink) and into the small state the
 * footer draws. Plain TypeScript, no React: the bridge, the sink, the clock and
 * the terminal width are injected, so tests drive it with a mock bridge and a
 * memory sink. `useController` is the thin hook over getState()/subscribe().
 *
 * Rules the footer relies on:
 *  - one turn at a time: `code.turn` for the code agent, AIhub's `chat.turn`
 *    under plain chat or an AIhub agent (the `kind`, see setKind / HubChat);
 *    submit while a turn runs queues the prompt and the next one goes out
 *    after `done`;
 *  - a permission answer carries the prompt's `permission_id`; a second
 *    request replaces the first, and an answer meant for the old one is
 *    dropped (a hub turn's prompt has no id: a plain yes or no);
 *  - after cancel every event of that turn is ignored but `done` (a prompt
 *    that still arrives is denied at once, so the engine never waits for it);
 *  - when the bridge dies the phase becomes "error" with the client's message
 *    printed red; the queue is kept and the input stays usable;
 *  - one model request at a time, behind one gate (`isBusy()`: a turn, a
 *    /skill being fetched, a memory learn, /memoryadd's extract, a scheduled
 *    task): a scheduled task (SchedulerHost runs AIhub's clock) and a learn
 *    never start while it holds, a typed prompt waits in the queue (with one
 *    note per wait), and /compact, /skill and /memoryadd refuse; the task's
 *    output is a block in the transcript (TaskBlock).
 */
import type { StreamHandle } from "../bridge/client";
import type { Args, Mode } from "../args";
import { G } from "../glyphs";
import type { Line, ScrollbackSink } from "../scrollback";
import type { CompactionEvent, DiffEvent, TodoItem, ToolCallEvent, ToolResultEvent, UndoPlan } from "../transcript/events";
import {
  fmtCompaction,
  fmtAttached,
  fmtCommandEcho,
  fmtDiff,
  fmtDivider,
  fmtError,
  fmtHeader,
  fmtNote,
  fmtTodos,
  fmtUndoConflicts,
  fmtUndoPlan,
  fmtToolCall,
  fmtToolResult,
  fmtUser,
  undoSummary,
} from "../transcript/format";
import { MarkdownStreamer } from "../transcript/markdown";
import { exitLine } from "../replay";
import { sanitize, stripCR } from "../width";
import type { Attachment } from "../bridge/types";
import { Attachments } from "./attachments";
import { agentNote, HubChat, type ChatMessage, type HubKind } from "./hubChat";
import { CODE, fmtKnowledge, hubDiff, kindHeader, kindLabel, sameKind, type AgentCheck, type Kind } from "./kinds";
import { fmtMemoryChange, Learner } from "./learn";
import { TaskBlock } from "./taskBlock";
import type { MissedTask } from "../hub/schedule/types";

/** What the controller needs of BridgeClient (tests pass a mock). */
export interface Bridge {
  ready(): Promise<{ version: string }>;
  request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  stream(method: string, params: Record<string, unknown>, onEvent: (event: string, data: any) => void): StreamHandle;
  permission(requestId: number, allow: boolean, extra?: Record<string, unknown>): void;
  send(control: { method: string; params?: Record<string, unknown> }): void;
  /** Why the bridge is gone, or null while it lives. */
  deadError(): Error | null;
  /** Called once if the bridge process dies (never for a close on purpose). */
  onDead?(fn: (err: Error) => void): void;
}

/** Where a model runs: on the Ollama server, or behind a provider's API. */
export type Backend = "ollama" | "api";

export type Phase = "starting" | "idle" | "running" | "permission" | "picker" | "error";

export interface SuggestedRule {
  tool: string;
  pattern: string | null;
  scope: string;
}

/** The open permission prompt (a `permission_request` event). */
export interface PermissionState {
  /** The streaming request it belongs to (what chat.permission calls request_id). */
  requestId: number;
  /** Echoed in the answer; null only if an old engine sent none. */
  permissionId: number | null;
  name: string;
  arguments: Record<string, unknown>;
  diff: DiffEvent | null;
  suggestedRule: SuggestedRule | null;
  mode: string;
  reason: string;
  /** From an AIhub chat/agent turn: a plain yes or no (its protocol takes no
   *  message and no rule). */
  hub: boolean;
}

export interface PickerItem {
  id: string;
  label: string;
}

export interface PickerState {
  kind: "model" | "session";
  title: string;
  items: PickerItem[];
}

/** A yes/no question the footer asks in place of the input box (`/undo`). */
export interface ConfirmState {
  question: string;
  /** One line above the question, e.g. what would be restored. */
  detail: string;
  /** The undo goes ahead over files that changed after the turn. */
  force: boolean;
}

/** AIhub's windows, opened as panels above the prompt. */
export type PanelId =
  | "memory"
  | "models"
  | "hardware"
  | "agents"
  | "skills"
  | "mcp"
  | "knowledge"
  | "schedule"
  | "missed"
  | "history"
  | "settings"
  | "theme"
  | "temperature"
  | "palette"
  | "help";

export interface ControllerState {
  phase: Phase;
  /** The code agent's mode (kept while another kind is in front). */
  mode: Mode;
  kind: Kind;
  model: string;
  /** How the model is reached, and the name the engine streams it under. */
  backend: Backend;
  streamModel: string;
  /** The sampling temperature (the engine's config; `/temp`). */
  temperature: number;
  sessionId: string;
  ctx: { used: number; limit: number };
  activity: { label: string; since: number } | null;
  permission: PermissionState | null;
  queue: string[];
  todos: TodoItem[];
  /** The message behind phase "error". */
  error: string | null;
  picker: PickerState | null;
  confirm: ConfirmState | null;
  /** The AIhub window open in place of the prompt, or null. `viewOnly`: the
   *  models window opened while a turn ran (look, don't pick). */
  panel: { id: PanelId; arg?: string; viewOnly?: boolean } | null;
  /** Text for the prompt box (the skills window's "use"): the footer puts it
   *  there when `seq` changes. */
  prefill: { text: string; seq: number } | null;
  /** Images waiting for the next turn (the prompt box's chips). */
  images: Attachment[];
  /** The enabled skills, for the footer's `/skill <name>` suggestions. */
  skills: { name: string; description: string }[];
  /** The knowledge bases this conversation draws on (`/kb`): the code
   *  session's, or the AIhub chat's, whichever is in front. */
  knowledge: string[];
  /** MCP servers are on for the code session. */
  mcp: boolean;
  /** Every knowledge base there is, for `/kb <name>` suggestions. */
  kbNames: string[];
  /** The scheduled task running now (it has the model), or null. */
  taskRunning: string | null;
  /** AIhub's Settings switches: tools for chat and agent turns (the code
   *  agent always has its tools), and memory (the engine reads it itself). */
  toolsEnabled: boolean;
  memoryEnabled: boolean;
}

/** What SchedulerHost hands the controller of AIhub's clock (useScheduler). */
export interface SchedulerHandle {
  runNow(name: string): void;
  /** Cancel the running task (the routed chat.cancel). */
  cancel(): void;
  /** Live, for the Schedule window. */
  isRunning(): string | null;
  lastEnded(): { name: string; n: number };
  /** On quit: start nothing new, cancel the running task, resolve at its end. */
  stop(): Promise<void>;
}

export type PermissionChoice = "yes" | "always" | { no: string | null };

export type CommandFn = (controller: Controller, arg: string) => void | Promise<void>;

export interface ControllerOptions {
  bridge: Bridge;
  sink: ScrollbackSink;
  /** Milliseconds; injectable so tests are deterministic. */
  now?: () => number;
  /** The terminal width at the time of writing. */
  width: () => number;
  /** The project folder (the bridge's cwd). */
  cwd?: string;
  /** What the header shows as `~`. */
  home?: string;
  /** Slash command table (name without the slash). */
  commands?: Record<string, CommandFn>;
  /** Called by exit(); the app destroys the renderer here. */
  onExit?: () => void;
  /** A resumed session's saved messages, for the app to replay into the scrollback. */
  onResume?: (messages: any[]) => void;
  /** /new or /clear: the app clears the screen, its saved lines and its
   *  transcript; the fresh view (header, notes) is written right after. */
  onFresh?: () => void;
  /** How long exit() waits for an interrupted turn (or a cancelled scheduled
   *  task) to end — the engine saves the session then — before it goes anyway. */
  exitGraceMs?: number;
}

/** `gemma4:cloud`, `gpt-oss:120b-cloud`: runs on ollama.com. */
const CLOUD_TAG = /:(?:[^:]*-)?cloud$/;
/** `qwen2.5-coder` is `qwen2.5-coder:latest`. */
const withTag = (name: string): string => (name.includes(":") ? name : `${name}:latest`);

interface BeginOptions {
  /** The model's backend and stream name (a model picked from the API list). */
  backend?: Backend;
  streamModel?: string;
  /** Write a divider instead of the header: the conversation continues below. */
  divider?: "model";
  /** /new, /clear: the screen starts over with the header; the code session
   *  left behind is named in a line under it. */
  fresh?: { previous?: string };
}

const MODES: Mode[] = ["build", "auto", "plan"];
const SHELL_TOOLS = new Set(["run_terminal", "run_shell"]);

interface Turn {
  handle: StreamHandle | null;
  cancelled: boolean;
  streamer: MarkdownStreamer;
  /** The AIhub conversation a chat.turn belongs to; null for the code agent. */
  hub: HubChat | null;
  /** Text was streamed since the last round (a round's text is then on screen). */
  streamed: boolean;
  /** A prompt's turn (not a compaction): its end is learned from. */
  prompt: boolean;
  /** A fatal chat_error came: the engine stopped the turn (its done carries
   *  no error, and the messages end without a reply). */
  failed: boolean;
}

export class Controller {
  private state: ControllerState = {
    phase: "starting",
    mode: "build",
    kind: CODE,
    model: "",
    backend: "ollama",
    streamModel: "",
    temperature: 0.7,
    sessionId: "",
    ctx: { used: 0, limit: 0 },
    activity: null,
    permission: null,
    queue: [],
    todos: [],
    error: null,
    picker: null,
    confirm: null,
    panel: null,
    prefill: null,
    images: [],
    skills: [],
    knowledge: [],
    mcp: false,
    kbNames: [],
    taskRunning: null,
    toolsEnabled: true,
    memoryEnabled: true,
  };
  private listeners = new Set<() => void>();
  private turn: Turn | null = null;
  private version = "";
  private startArgs: Pick<Args, "mcp" | "kb" | "model"> & { mode: Mode } = { mode: "build", mcp: [], kb: [] };
  private shownNotes = new Set<string>();
  private turnsSent = 0;
  private resumed = false;
  private exited = false;
  // Mode changes: the engine takes one at a time, so quick presses coalesce.
  private modeConfirmed: Mode = "build";
  private modeWanted: Mode | null = null;
  private modeBusy = false;
  // An undo is in flight (preview or confirm): no turn may start meanwhile.
  private undoBusy = false;
  // A picker's list is being fetched (/model, /sessions): same.
  private listing = false;
  // Where Esc in a command's picker goes back to, when there is no session to
  // go back to (after a failed start: "error"). Null for start-up pickers.
  private pickerBack: Phase | null = null;
  // The AIhub conversation in front (chat / agent kinds), or null.
  private hub: HubChat | null = null;
  // Images waiting for the next turn, and which models are known to see them.
  private readonly attachments = new Attachments();
  private vision = new Map<string, boolean>();
  // The images of each queued prompt, in step with `state.queue`.
  private queuedImages: Attachment[][] = [];
  // The code session as it was when another kind came in front.
  // The code session's knowledge bases and MCP as the engine has them (the
  // state mirrors them while the code agent is in front, or the chat's).
  private codeOpts: { mcp: boolean; knowledge: string[] } = { mcp: false, knowledge: [] };
  // A change asked for while a turn runs: it goes out when the turn is over.
  private pendingOpts: { mcp?: boolean; knowledge?: string[]; done: (() => void)[] } | null = null;
  private optsBusy = false;
  // /kb or /mcp changed something: a new code session carries it over.
  private optsTouched = false;
  private kbList: { name: string; description: string }[] = [];
  private codeSnap: { model: string; backend: Backend; streamModel: string; ctx: { used: number; limit: number }; resume: string } | null = null;
  // Plain chat's context while an agent enlarged it (AIhub restores it).
  private chatCtx: number | null = null;
  // Code sessions whose resume line is already in the transcript.
  private resumeLineShown = new Set<string>();
  // A kind switch (or a new hub conversation) is under way.
  private switching = false;
  // From AIhub's settings, for chat.turn.
  private defaultContext = 2048;
  // Automatic memory: learns after turns, once the user has gone quiet.
  private readonly learner: Learner;
  // A /skill's text is being fetched: its turn goes out first.
  private invoking = false;
  // AIhub's clock (SchedulerHost), the running task's block, whether the
  // queue's "waiting for task" note was said for this run, and the answer
  // the missed panel owes the clock.
  private scheduler: SchedulerHandle | null = null;
  private task: TaskBlock | null = null;
  private taskWaitNoted = false;
  private missedAnswer: ((choice: "run" | "skip") => void) | null = null;
  // /memoryadd's memory.extract requests on the wire (the model is in use).
  private extracting = 0;
  // The queue's "waiting for memory" note was said for this wait.
  private memoryWaitNoted = false;

  constructor(private readonly o: ControllerOptions) {
    // A bridge that dies between turns is said at once, not at the next Enter.
    o.bridge.onDead?.((err) => this.bridgeDied(err));
    this.learner = new Learner(o.bridge, undefined, {
      isBusy: () => this.isBusy(),
      // A prompt (or a task) that waited for the learn may go now.
      onSettled: () => this.modelFreed(),
      onChanges: (changes) => {
        if (!this.exited) for (const c of changes) this.write(fmtMemoryChange(c, this.o.width()));
      },
      onError: (text) => {
        if (!this.exited && !this.o.bridge.deadError()) this.error(text);
      },
    });
  }

  // ── state ──────────────────────────────────────────────────────────────────

  getState = (): ControllerState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    // The models window opened view-only while a turn ran is a normal one
    // again once the turn is over: this is the one source of "view only".
    const { panel, phase } = this.state;
    if (panel?.viewOnly && phase !== "running" && phase !== "permission") {
      this.state = { ...this.state, panel: { id: panel.id, ...(panel.arg === undefined ? {} : { arg: panel.arg }) } };
    }
    for (const fn of [...this.listeners]) fn();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The terminal width now (commands wrap their own lines). */
  columns(): number {
    return this.o.width();
  }

  write(lines: Line[]): void {
    if (lines.length) this.o.sink.write(lines);
  }

  error(text: string): void {
    this.write(fmtError(text, this.o.width()));
  }

  note(text: string): void {
    this.write(fmtNote(text, this.o.width()));
  }

  /** The folder aihub-code was started in (the tools work there). */
  cwd(): string {
    return this.o.cwd ?? process.cwd();
  }

  /** A bridge call for the commands. */
  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.o.bridge.request<T>(method, params);
  }

  // ── start-up ───────────────────────────────────────────────────────────────

  async start(args: Args): Promise<void> {
    this.startArgs = { mode: args.mode ?? "build", mcp: args.mcp, kb: args.kb, model: args.model };
    try {
      this.version = (await this.o.bridge.ready()).version;
    } catch (e) {
      return this.failStart(e);
    }
    let config: Record<string, unknown> = {};
    try {
      config = await this.o.bridge.request("config.get", {});
    } catch (e) {
      if (this.o.bridge.deadError()) return this.failStart(e);
      this.note(`could not read AIhub's settings: ${errText(e)}`);
    }
    this.set({ toolsEnabled: config.tools_enabled !== false, memoryEnabled: config.memory_enabled !== false });
    this.defaultContext = Number(config.default_context_length) || 2048;
    const cwd = this.o.cwd ?? process.cwd();
    try {
      if (typeof args.resume === "string") return await this.resume(args.resume);
      if (args.cont || args.resume === true) {
        const { sessions = [] } = await this.o.bridge.request<{ sessions?: any[] }>("code.sessions", { cwd });
        if (sessions.length === 0) {
          this.note("no earlier session here: starting a new one");
        } else if (args.resume === true) {
          return this.openPicker({
            kind: "session",
            title: "Resume a session",
            items: sessions.map((s) => ({ id: String(s.id), label: sessionLabel(s) })),
          });
        } else {
          return await this.resume(String(sessions[0].id));
        }
      }
      const model = args.model || String(config.default_chat_model ?? "").trim();
      if (!model) return await this.pickModel();
      await this.startSession(model, true);
    } catch (e) {
      this.failStart(e);
    }
  }

  /** Picker answer: a model or a session to resume (at start-up, or from /model
   *  and /sessions). Esc with a live session just closes the picker; before
   *  the first session it means "no choice": a new session on the default
   *  model, or leaving when there is no model. */
  async pick(id: string | null): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    const live = this.state.sessionId !== "";
    const back = this.pickerBack;
    this.pickerBack = null;
    if (id === null && live) {
      this.set({ picker: null, phase: "idle" });
      this.drainQueue();
      return;
    }
    if (id === null && back !== null) {
      this.set({ picker: null, phase: back });
      return;
    }
    if (picker.kind === "model" && id !== null && live && this.state.kind.type !== "code") {
      this.set({ picker: null, phase: "idle" });
      return this.useModel({ name: id, backend: "ollama" });
    }
    await this.replaceSession(async () => {
      if (picker.kind === "model") {
        if (id === null) return this.exit();
        // It came from the server's own list.
        await this.startSession(id, false, live ? { mode: this.state.mode, divider: "model" } : {});
      } else if (id === null) {
        const model = this.startArgs.model || (await this.o.bridge.request<Record<string, unknown>>("config.get", {})).default_chat_model;
        if (!model) return await this.pickModel();
        await this.startSession(String(model), true);
      } else {
        await this.resume(id);
      }
    });
  }

  /** "starting" while a session comes up: prompts typed meanwhile queue. If it
   *  fails, a live session stays as it was and the failure is just printed. */
  private async replaceSession(open: () => Promise<void>): Promise<void> {
    this.set({ picker: null, phase: "starting" });
    try {
      await open();
    } catch (e) {
      if (this.state.sessionId && !this.o.bridge.deadError()) {
        this.error(errText(e));
        this.set({ phase: "idle" });
        this.drainQueue();
      } else {
        this.failStart(e);
      }
    }
  }

  private async pickModel(missing?: string): Promise<void> {
    if (missing) this.note(`model ${missing} isn't available on the server \u2014 pick one`);
    const { models = [] } = await this.o.bridge.request<{ models?: { name: string }[] }>("models.installed", {});
    this.openPicker({
      kind: "model",
      title: "Choose a model",
      items: models.map((m) => ({ id: m.name, label: m.name })),
    });
  }

  /** True only when the server's own list is known and lacks the model. Never
   *  blocks start-up: an empty or failed answer (the engine reports an offline
   *  server as an empty list) and cloud names (not listed locally until used)
   *  count as "unknown", and cloud.models is never asked (it can crawl the web). */
  private async modelMissing(model: string): Promise<boolean> {
    if (CLOUD_TAG.test(model)) return false;
    try {
      const { models } = await this.o.bridge.request<{ models?: { name: string }[] }>("models.installed", {});
      if (!Array.isArray(models) || models.length === 0) return false;
      const want = withTag(model);
      return !models.some((m) => withTag(String(m.name)) === want);
    } catch {
      return false;
    }
  }

  private openPicker(picker: PickerState, back: Phase | null = null): void {
    this.pickerBack = back;
    this.set({ phase: "picker", picker });
  }

  /** With `check`, a model missing from the server's installed list opens the
   *  picker instead; if that cannot be told, we go ahead and the turn reports it. */
  private async startSession(model: string, check: boolean, opts: BeginOptions & { mode?: Mode } = {}): Promise<void> {
    if (check && (await this.modelMissing(model))) return this.pickModel(model);
    const { mcp, kb } = this.startArgs;
    // A /clear or /model keeps what /kb and /mcp chose (a start flag otherwise).
    const carry = this.optsTouched ? this.wantedOpts() : null;
    this.pendingOpts = null;
    let info = await this.o.bridge.request("code.start", {
      cwd: this.o.cwd ?? process.cwd(),
      model,
      mode: opts.mode ?? this.startArgs.mode,
      mcp,
      knowledge: carry ? carry.knowledge : kb,
      ...(opts.backend ? { backend: opts.backend } : {}),
      ...(opts.streamModel ? { stream_model: opts.streamModel } : {}),
    });
    if (carry && carry.mcp !== !!info.mcp) {
      try {
        info = { ...info, ...(await this.o.bridge.request("code.options", { mcp: carry.mcp })) };
      } catch (e) {
        this.error(`Keeping MCP ${carry.mcp ? "on" : "off"} failed: ${errText(e)}`);
      }
    }
    this.turnsSent = 0;
    this.resumed = false;
    this.begin(info, model, undefined, opts);
  }

  private async resume(sessionId: string): Promise<void> {
    const info = await this.o.bridge.request("code.resume", { cwd: this.o.cwd ?? process.cwd(), session_id: sessionId });
    this.turnsSent = 0;
    this.resumed = true;
    this.begin(info, "", Array.isArray(info.messages) ? info.messages : undefined);
  }

  /** The session exists: header (or a divider when the conversation goes on
   *  below an earlier one), notes, the resumed conversation, state. */
  private begin(info: any, fallbackModel: string, resumedMessages?: any[], opts: BeginOptions = {}): void {
    const project = info.project ?? {};
    const model = String(info.model || fallbackModel);
    const mode = MODES.includes(info.mode) ? (info.mode as Mode) : "build";
    this.modeConfirmed = mode;
    this.dropImages(); // a new conversation starts without the old one's pending images
    if (opts.fresh) this.o.onFresh?.();
    if (opts.divider) {
      this.write(fmtDivider(opts.divider === "model" ? `new session with ${model}` : "new session", this.o.width()));
    } else {
      this.write(
        fmtHeader(
          { version: this.version, model, mode, root: String(project.root ?? ""), branch: project.branch, home: this.o.home },
          this.o.width(),
        ),
      );
      if (project.instruction_file) this.note(`${project.instruction_file} loaded`);
      if (project.is_git === false) this.note("not a git repository");
    }
    if (opts.fresh?.previous) {
      this.resumeLineShown.add(opts.fresh.previous);
      this.note(`Previous session: aihub-code --resume ${opts.fresh.previous}`);
    }
    this.checkpointNote(info.checkpoints?.note);
    this.codeOpts = {
      mcp: typeof info.mcp === "boolean" ? info.mcp : this.startArgs.mcp.length > 0,
      knowledge: Array.isArray(info.knowledge) ? info.knowledge.map(String) : [...this.startArgs.kb],
    };
    // A new conversation: the one before is learned from now, this one afresh.
    this.learner.reset();
    if (resumedMessages) this.o.onResume?.(resumedMessages); // before any queued prompt is written
    this.set({
      phase: "idle",
      error: null,
      picker: null,
      mode,
      model,
      backend: info.backend === "api" ? "api" : "ollama",
      streamModel: String(info.stream_model || model),
      temperature: typeof info.temperature === "number" ? info.temperature : this.state.temperature,
      sessionId: String(info.session_id ?? ""),
      ctx: { used: 0, limit: Number(info.context_length) || 0 },
      todos: [],
      mcp: this.codeOpts.mcp,
      ...(this.state.kind.type === "code" ? { knowledge: [...this.codeOpts.knowledge] } : {}),
    });
    this.drainQueue();
  }

  private checkpointNote(text: unknown): void {
    if (typeof text !== "string" || !text || this.shownNotes.has(text)) return;
    this.shownNotes.add(text);
    this.note(text);
  }

  private failStart(e: unknown): void {
    if (this.state.phase === "error") return; // already reported
    const msg = errText(e);
    this.error(msg);
    this.set({ phase: "error", error: msg, activity: null, permission: null, picker: null });
  }

  // ── prompts ────────────────────────────────────────────────────────────────

  /** A line from the prompt: `/command args` runs at once (never queued);
   *  `//text` is a prompt that begins with a slash; anything else is a prompt. */
  submit(text: string): void {
    // Leaving: nothing typed during the exit wait may start new work.
    if (this.exited || text.trim() === "") return;
    const head = text.trimStart();
    if (head.startsWith("//")) text = head.slice(1);
    else if (head.startsWith("/")) {
      const m = /^\/(\S*)\s*([\s\S]*)$/.exec(head.trimEnd())!;
      this.write(fmtCommandEcho(head, this.o.width()));
      void this.runCommand(m[1]!.toLowerCase(), m[2]!);
      return;
    }
    const dead = this.o.bridge.deadError();
    if (dead) return this.bridgeGone(dead);
    const { phase } = this.state;
    if (!this.state.sessionId && phase !== "starting") {
      this.error(
        phase === "picker" ? "no session yet — choose one first" : "no session — fix the problem above, or /exit",
      );
      return;
    }
    // Always behind what is already waiting; it goes out at once only when
    // nothing is in the way (a turn, the session starting, a mode change).
    // The images attached so far belong to this prompt, not to a later one.
    this.queuedImages.push(this.attachments.list());
    this.attachments.clear();
    this.set({ queue: [...this.state.queue, text], images: [] });
    this.drainQueue();
  }

  private bridgeGone(dead: Error): void {
    this.error(`the bridge is gone — restart aihub-code (${dead.message})`);
    this.set({ phase: "error", error: dead.message, activity: null, permission: null });
  }

  /** The client's death hook. A turn reports it itself (its stream fails),
   *  and so does a start-up (failStart): only a quiet bridge needs the line. */
  private bridgeDied(err: Error): void {
    if (this.exited || this.turn || this.state.phase === "error" || this.state.phase === "starting") return;
    this.bridgeGone(err);
  }

  private drainQueue(): void {
    if (this.exited || this.turn || this.modeBusy || this.undoBusy || this.listing || this.switching || this.invoking) return;
    if (this.state.confirm || this.state.picker || this.state.phase === "starting") return;
    // /kb or /mcp asked for during a turn: the engine takes it before the next one.
    if ((this.pendingOpts || this.optsBusy) && this.state.sessionId) {
      void this.flushOptions();
      return;
    }
    // A turn under an open panel would squeeze into the row above it, and a
    // permission prompt would unmount the window: the queue waits for closePanel.
    if (this.state.panel) return;
    if (!this.state.sessionId || this.o.bridge.deadError()) return;
    const [next, ...rest] = this.state.queue;
    if (next === undefined) return;
    // A scheduled task has the model: the prompt goes right after it (taskIdle).
    const task = this.state.taskRunning;
    if (task) {
      if (!this.taskWaitNoted) this.note(`Waiting for task ${task}\u2026 your message goes right after.`);
      this.taskWaitNoted = true;
      return;
    }
    // Memory (a learn, /memoryadd) has the model: right after it (modelFreed).
    if (this.memoryBusy()) {
      if (!this.memoryWaitNoted) this.note("Waiting for memory\u2026 your message goes right after.");
      this.memoryWaitNoted = true;
      return;
    }
    this.memoryWaitNoted = false;
    const images = this.queuedImages.shift() ?? [];
    this.set({ queue: rest });
    this.sendTurn(next, undefined, images);
  }

  /** A prompt goes to the kind in front: the code session (`code.turn`) or
   *  the AIhub conversation (`chat.turn`). `wire`: what the model gets when
   *  it isn't what was typed (a /skill's instructions; its echo is written). */
  private sendTurn(text: string, wire?: string, images: Attachment[] = []): void {
    const ids = images.map((a) => a.id);
    if (wire === undefined) {
      this.write([[], ...fmtUser(text, this.o.width())]);
      if (images.length) this.write(fmtAttached(images, this.o.width()));
    }
    const body = wire ?? text;
    const hub = this.state.kind.type === "code" ? null : this.hub;
    if (hub) {
      hub.temperature = this.state.temperature;
      hub.contextLength = this.contextLength();
      hub.toolsEnabled = this.state.toolsEnabled;
      this.startStream("chat.turn", hub.params(body, ids), "thinking…", hub, true);
      return;
    }
    this.turnsSent++;
    this.startStream("code.turn", ids.length ? { text: body, images: ids } : { text: body }, "thinking…", null, true);
  }

  /** The context the next turn runs with (AIhub's contextLength). */
  private contextLength(): number {
    return this.state.ctx.limit > 0 ? this.state.ctx.limit : this.defaultContext;
  }

  /** A streaming call the engine runs on the session (a turn, a compaction):
   *  one at a time, cancellable, its events drawn by onEvent. */
  private startStream(method: string, params: Record<string, unknown>, label: string, hub: HubChat | null = null, prompt = false): void {
    const turn: Turn = { handle: null, cancelled: false, streamer: new MarkdownStreamer(this.o.width()), hub, streamed: false, prompt, failed: false };
    this.turn = turn;
    this.set({ phase: "running", activity: { label, since: this.now() } });
    turn.handle = this.o.bridge.stream(method, params, (event, data) => this.onEvent(turn, event, data));
    turn.handle.done.then(
      (data) => this.onDone(turn, data),
      (err) => this.onFail(turn, err),
    );
  }

  // ── turn events ────────────────────────────────────────────────────────────

  private onEvent(turn: Turn, event: string, data: any): void {
    if (this.turn !== turn || turn.cancelled) {
      // The engine may still be waiting on a prompt that slipped past the
      // cancel: refuse it, so it never blocks the turn's end.
      if (event === "permission_request") this.denyUnseen(turn, data);
      return;
    }
    const width = this.o.width();
    switch (event) {
      case "text":
        turn.streamed = true;
        this.write(turn.streamer.feed(String(data.text ?? "")));
        this.activity("writing…");
        break;
      case "thinking":
        this.activity("thinking…");
        break;
      case "tool_call": {
        this.flush(turn);
        const ev = data as ToolCallEvent;
        this.write(fmtToolCall(ev, width));
        this.activity(activityFor(ev));
        break;
      }
      case "tool_result": {
        this.flush(turn);
        const ev = data as ToolResultEvent;
        let rows = fmtToolResult(ev, width);
        // An edit's outcome is the code agent's code_diff, which AIhub's turns
        // never send: say its result as any other tool's.
        if (turn.hub && rows.length === 0) rows = fmtToolResult({ ...ev, name: "" }, width);
        this.write(rows);
        this.activity("thinking…");
        break;
      }
      case "code_diff":
        this.flush(turn);
        this.write(fmtDiff(data as DiffEvent, width));
        break;
      case "code_todos": {
        this.flush(turn);
        const todos: TodoItem[] = Array.isArray(data.todos) ? data.todos : [];
        this.write(fmtTodos(todos, width));
        this.set({ todos });
        break;
      }
      case "code_compaction":
        this.flush(turn);
        this.write(fmtCompaction(data as CompactionEvent, this.state.ctx.limit || undefined));
        if (typeof data.after === "number") this.set({ ctx: { ...this.state.ctx, used: data.after } });
        break;
      case "code_context":
        this.set({ ctx: { used: Number(data.used) || 0, limit: Number(data.limit) || this.state.ctx.limit } });
        break;
      case "code_checkpoint":
        this.flush(turn);
        this.checkpointNote(data.note);
        break;
      case "chat_error":
        this.flush(turn);
        if (data.fatal !== false) turn.failed = true;
        this.error(String(data.message ?? "error"));
        break;
      case "permission_request":
        this.flush(turn);
        this.set({
          phase: "permission",
          activity: null,
          permission: {
            requestId: turn.handle!.id,
            permissionId: typeof data.permission_id === "number" ? data.permission_id : null,
            name: String(data.name ?? ""),
            arguments: data.arguments && typeof data.arguments === "object" ? data.arguments : {},
            diff: turn.hub ? hubDiff(String(data.name ?? ""), data.arguments) : (data.diff ?? null),
            suggestedRule: turn.hub ? null : (data.suggested_rule ?? null),
            mode: String(data.mode ?? ""),
            reason: String(data.reason ?? ""),
            hub: turn.hub !== null,
          },
        });
        break;
      default:
        if (turn.hub) this.onHubEvent(turn, event, data);
      // code turns: usage, round, final, ...: nothing to show.
    }
  }

  /** What only AIhub's chat.turn sends (ChatScreen 527–600). */
  private onHubEvent(turn: Turn, event: string, data: any): void {
    switch (event) {
      case "round": {
        // The round's reply is complete. AIhub logs its text here; ours was
        // streamed already, unless the round sent none (then it is written now).
        const text = String(data.text ?? "");
        if (!turn.streamed && text.trim()) this.write(turn.streamer.feed(text));
        this.flush(turn);
        turn.streamed = false;
        break;
      }
      case "usage": {
        const used = Number(data.prompt_tokens) || this.state.ctx.used;
        this.set({ ctx: { ...this.state.ctx, used } });
        break;
      }
      case "knowledge":
        // Which documents the answer can draw on, or why it can't.
        this.flush(turn);
        this.write(fmtKnowledge(data, this.o.width()));
        break;
    }
  }

  private flush(turn: Turn): void {
    this.write(turn.streamer.flush());
  }

  /** The activity line, unless a prompt is open (it replaces the line). */
  private activity(label: string): void {
    if (this.state.permission) return;
    const cur = this.state.activity;
    if (cur?.label === label) return;
    this.set({ activity: { label, since: this.now() } });
  }

  private denyUnseen(turn: Turn, data: any): void {
    const extra = typeof data.permission_id === "number" ? { permission_id: data.permission_id } : {};
    this.o.bridge.permission(turn.handle!.id, false, extra);
  }

  private onDone(turn: Turn, data: any): void {
    if (this.turn !== turn) return;
    if (!turn.cancelled) this.flush(turn);
    this.turn = null;
    if (turn.hub) this.hubTurnDone(turn.hub, data, turn.cancelled);
    else if (turn.prompt) this.learner.codeTurn(data?.messages, this.state.model, this.state.sessionId, !turn.cancelled);
    // A turn the engine stopped on an error has said why (AIhub's error path
    // never reaches the note either).
    if (turn.prompt && !turn.cancelled && !turn.failed) this.emptyAnswerNote(data?.messages);
    this.set({ phase: "idle", activity: null, permission: null });
    this.drainQueue();
  }

  /** Small models sometimes think, run a tool, and then say nothing
   *  (ChatScreen's done handler). */
  private emptyAnswerNote(messages: unknown): void {
    const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
    if (last && !(last.role === "assistant" && String(last.content || "").trim()))
      this.error("The model ended without an answer — ask it to continue, or try a bigger model.");
  }

  /** The engine's messages become the conversation (an interrupted turn's
   *  too: the prompt and the partial reply); a finished turn is saved to
   *  AIhub's history (autosave), as ChatScreen does after each reply. */
  private hubTurnDone(hub: HubChat, data: any, cancelled: boolean): void {
    hub.accept(data?.messages);
    if (hub !== this.hub) return;
    if (cancelled) {
      // Not saved now (AIhub saves after a reply), but on quit or /agent code.
      if (hub.hasUserMessages()) hub.unsaved = true;
      return this.learner.remember(hub.messages, hub.model, hub.startTime);
    }
    hub.finalize(true).catch((e) => {
      if (!this.exited) this.error(`Saving the chat failed: ${errText(e)}`);
    });
    this.learner.schedule(hub.messages, hub.model, hub.startTime);
  }

  private onFail(turn: Turn, err: unknown): void {
    if (this.turn !== turn) return;
    if (!turn.cancelled) this.flush(turn);
    this.turn = null;
    const msg = errText(err);
    this.error(msg);
    if (this.o.bridge.deadError()) {
      // The queue stays: it is the user's typing, and it is still shown.
      this.set({ phase: "error", error: msg, activity: null, permission: null });
    } else {
      this.set({ phase: "idle", activity: null, permission: null });
      this.drainQueue(); // what was typed meanwhile still goes out, in order
    }
  }

  // ── permission, cancel ─────────────────────────────────────────────────────

  /** Answer the open prompt. `permissionId` is the id of the prompt the user
   *  was looking at: an answer to a prompt that has since been replaced is dropped. */
  answer(choice: PermissionChoice, permissionId: number | null): void {
    const p = this.state.permission;
    if (!p || !this.turn) return;
    if (permissionId !== p.permissionId) return;
    if (p.hub) {
      // AIhub's chat.permission is {request_id, allow}: nothing to remember, no message.
      if (choice === "always") return;
      const allow = choice === "yes";
      this.o.bridge.permission(p.requestId, allow);
      this.set({ phase: "running", permission: null, activity: { label: allow ? `running ${p.name}…` : "thinking…", since: this.now() } });
      return;
    }
    const extra: Record<string, unknown> = {};
    if (p.permissionId !== null) extra.permission_id = p.permissionId;
    let allow = true;
    if (choice === "always" && p.suggestedRule) extra.remember = "project";
    if (typeof choice === "object") {
      allow = false;
      const message = choice.no?.trim();
      if (message) extra.message = message;
    }
    this.o.bridge.permission(p.requestId, allow, extra);
    this.set({
      phase: "running",
      permission: null,
      activity: { label: allow ? `running ${p.name}…` : "thinking…", since: this.now() },
    });
  }

  /** Interrupt the running turn (Esc / Ctrl+C). The engine finishes on its own
   *  time, so the phase stays "running" (activity "interrupting…") until `done`;
   *  events meanwhile are dropped, and a second cancel does nothing. */
  cancel(): void {
    const turn = this.turn;
    if (!turn || turn.cancelled) return;
    this.flush(turn);
    turn.cancelled = true;
    turn.handle?.cancel();
    this.note(`  ${G.elbow} interrupted`);
    // What was typed behind the turn was written for a plan the user just
    // stopped: it does not go out on its own (Up brings it back).
    const n = this.state.queue.length;
    if (n > 0) this.note(`dropped ${n} queued prompt${n === 1 ? "" : "s"}`);
    this.set({ phase: "running", activity: { label: "interrupting…", since: this.now() }, permission: null, queue: [] });
    this.queuedImages = [];
  }

  // ── mode ───────────────────────────────────────────────────────────────────

  /** Shift+Tab: the code agent's modes; an AIhub agent's build/plan; nothing in chat. */
  cycleMode(): void {
    const k = this.state.kind;
    if (k.type === "chat") return;
    if (k.type === "agent") {
      const next: Kind = { ...k, submode: k.submode === "plan" ? "build" : "plan" };
      if (this.hub) this.hub.kind = next;
      this.set({ kind: next });
      this.note(kindLabel(next, this.state.mode));
      return;
    }
    this.setMode(MODES[(MODES.indexOf(this.state.mode) + 1) % MODES.length]!);
  }

  setMode(mode: Mode): void {
    if (!this.state.sessionId || mode === this.state.mode) return;
    // code.mode would race code.start / code.undo for the engine's session.
    const wait = this.turn
      ? "mode can change when the turn is done"
      : this.state.phase === "starting"
        ? "mode can change when the session is ready"
        : this.undoBusy || this.state.confirm
          ? "mode can change once the undo is done"
          : this.listing
            ? "mode can change when the list has loaded"
            : null;
    if (wait) {
      this.note(wait);
      return;
    }
    this.set({ mode });
    this.modeWanted = mode;
    if (!this.modeBusy) void this.syncMode();
  }

  /** One code.mode at a time, always for the latest wanted mode. */
  private async syncMode(): Promise<void> {
    this.modeBusy = true;
    try {
      while (this.modeWanted !== null && this.modeWanted !== this.modeConfirmed) {
        const wanted = this.modeWanted;
        this.modeWanted = null;
        try {
          const r = await this.o.bridge.request<{ mode: Mode }>("code.mode", { mode: wanted });
          this.modeConfirmed = MODES.includes(r.mode) ? r.mode : wanted;
          // Nothing newer to send (or the user came back to this very mode).
          if (this.modeWanted === null || this.modeWanted === this.modeConfirmed) {
            this.modeWanted = null;
            this.note(`mode: ${this.modeConfirmed}`);
            this.set({ mode: this.modeConfirmed });
          }
        } catch (e) {
          this.modeWanted = null;
          this.error(errText(e));
          this.set({ mode: this.modeConfirmed });
        }
      }
    } finally {
      this.modeBusy = false;
      this.drainQueue(); // a prompt typed meanwhile was waiting for the engine
    }
  }

  // ── panels ─────────────────────────────────────────────────────────────────

  /** Open an AIhub window in place of the prompt. Not while a turn runs, asks
   *  for a permission or a picker is open: the window would take their keys.
   *  The one exception is the models window while a turn runs: it opens view
   *  only (no picking until the turn is over), and a permission prompt that
   *  comes meanwhile is drawn in its place until it is answered. */
  openPanel(id: PanelId, arg?: string): boolean {
    const { phase } = this.state;
    // The clock waits for this answer (and keys would go to the other window).
    if (this.state.panel?.id === "missed" && id !== "missed") {
      this.note("Answer the missed task first (enter run now, s skip).");
      return false;
    }
    const viewOnly = id === "models" && phase === "running";
    if (!viewOnly && (phase === "running" || phase === "permission" || phase === "picker")) {
      this.note("Finish or interrupt the current turn first (Esc).");
      return false;
    }
    this.set({ panel: { id, ...(arg === undefined ? {} : { arg }), ...(viewOnly ? { viewOnly } : {}) } });
    return true;
  }

  /** Close the open window; a non-empty `result` is said as a note, and what
   *  was queued meanwhile goes out. */
  closePanel(result?: string): void {
    if (!this.state.panel) return;
    // Closed without an answer: skipped, as Esc in AIhub's window is.
    if (this.state.panel.id === "missed") this.answerMissed("skip");
    this.set({ panel: null });
    if (result) this.note(result);
    this.drainQueue();
  }

  // ── scheduled tasks ────────────────────────────────────────────────────────
  // AIhub's clock runs in SchedulerHost (useScheduler); these are its hooks.

  /** SchedulerHost hands over the clock; the result detaches it. */
  attachScheduler(h: SchedulerHandle): () => void {
    this.scheduler = h;
    return () => {
      if (this.scheduler === h) this.scheduler = null;
    };
  }

  /** The clock, for the Schedule window (null before SchedulerHost mounts). */
  get tasks(): SchedulerHandle | null {
    return this.scheduler;
  }

  /** The one gate of "one model request at a time": a turn (or a /skill
   *  about to send one), memory learning, /memoryadd's extract, or a
   *  scheduled task. A scheduled task and a learn wait while it holds; typed
   *  prompts wait in the queue; /compact, /skill and /memoryadd refuse. */
  isBusy(): boolean {
    return this.turn !== null || this.invoking || this.memoryBusy() || this.state.taskRunning !== null;
  }

  /** Memory asks the model: a learn, or /memoryadd's extract. */
  private memoryBusy(): boolean {
    return this.learner.learning || this.extracting > 0;
  }

  /** A memory request ended: a prompt that waited goes out, and the clock
   *  (which listens to state changes) may start a task. */
  private modelFreed(): void {
    this.drainQueue();
    this.set({});
  }

  /** For what asks the model itself (/compact, /skill, /memoryadd): false,
   *  with a note, while something else has it. */
  modelFree(): boolean {
    const { phase, taskRunning } = this.state;
    if (this.turn || this.invoking || phase === "running" || phase === "permission") {
      this.note("Finish or interrupt the current turn first (Esc).");
      return false;
    }
    if (taskRunning) {
      this.note(`Task ${taskRunning} is using the model \u2014 try again when it is done.`);
      return false;
    }
    if (this.memoryBusy()) {
      this.note("Memory is using the model \u2014 try again when it is done.");
      return false;
    }
    return true;
  }

  /** `/memoryadd`'s request: it asks the model, so the queue, a learn and a
   *  scheduled task wait for it, and go once it has settled. */
  async extractMemory<T = any>(params: Record<string, unknown>): Promise<T> {
    this.extracting++;
    try {
      return await this.o.bridge.request<T>("memory.extract", params);
    } finally {
      this.extracting--;
      this.modelFreed();
    }
  }

  /** Run a task now (the Schedule window, /schedule run): after what runs. */
  runTask(name: string): boolean {
    if (!this.scheduler) {
      this.error("Scheduled tasks aren't running in this window.");
      return false;
    }
    this.scheduler.runNow(name);
    return true;
  }

  cancelTask(): void {
    this.scheduler?.cancel();
  }

  taskStarted(name: string): void {
    this.task = new TaskBlock(name, this.o.width, (lines) => {
      if (!this.exited) this.write(lines);
    });
    this.taskWaitNoted = false;
    this.set({ taskRunning: name });
  }

  taskEvent(event: string, data: any): void {
    this.task?.event(event, data);
  }

  /** The run is over (its result note follows). */
  taskEnded(): void {
    this.task?.end();
    this.task = null;
    this.set({ taskRunning: null });
  }

  /** After a task: a prompt that waited for it goes out. True when the model
   *  is taken again (the next task then waits for that reply). */
  taskIdle(): boolean {
    this.drainQueue();
    return this.turn !== null;
  }

  /** The clock's notes ("Task x finished…"); nothing once leaving. */
  taskNote(text: string, error = false): void {
    if (this.exited) return;
    if (error) this.error(text);
    else this.note(text);
  }

  /** Slots missed while aihub-code was closed: one missed panel each, once
   *  nothing else is on screen (after the start-up, between turns). */
  askMissed(task: MissedTask, index: number, total: number): Promise<"run" | "skip"> {
    return new Promise((resolve) => {
      const tryOpen = (): boolean => {
        const { phase, panel } = this.state;
        const free = phase === "idle" || (phase === "error" && !this.o.bridge.deadError());
        if (this.exited || this.missedAnswer || panel || !free) return false;
        this.missedAnswer = resolve;
        this.openPanel("missed", JSON.stringify({ task, index, total }));
        return true;
      };
      if (tryOpen()) return;
      // After what the change belongs to has run (a turn's end drains the queue first).
      let waiting = true;
      const unsub = this.subscribe(() =>
        queueMicrotask(() => {
          if (waiting && tryOpen()) {
            waiting = false;
            unsub();
          }
        }),
      );
    });
  }

  /** The missed panel's answer. */
  answerMissed(choice: "run" | "skip"): void {
    const answer = this.missedAnswer;
    this.missedAnswer = null;
    answer?.(choice);
  }

  // ── commands, exit ─────────────────────────────────────────────────────────

  async runCommand(name: string, arg: string): Promise<void> {
    if (this.exited) return;
    const fn = this.o.commands?.[name];
    if (!fn) {
      this.note(`unknown command /${sanitize(name)} \u2014 /help lists them`);
      // `/home/alex/x.py is broken` was meant as a prompt.
      if (name.includes("/")) this.note("to send text that starts with /, start it with //");
      return;
    }
    try {
      await fn(this, arg);
    } catch (e) {
      // A bridge that died meanwhile has had its red line (bridgeDied).
      if (this.o.bridge.deadError() && this.state.phase === "error") return;
      this.error(errText(e));
    }
  }

  /** For commands that need a session; says so when there is none. */
  requireSession(): boolean {
    if (this.state.sessionId) return true;
    this.note("no session yet");
    return false;
  }

  /** For the code agent's own commands: under another kind they say so
   *  instead of acting on the code session behind it. */
  requireCode(cmd: string): boolean {
    if (this.state.kind.type === "code") return true;
    this.note(`/${cmd} is for the code agent \u2014 /agent code switches back`);
    return false;
  }

  /** For commands that change or replace the session: only between turns
   *  (`allowTurn`: a kind switch interrupts the turn itself). */
  private canSwitch(allowTurn = false): boolean {
    const { phase, confirm, picker } = this.state;
    if (phase === "starting" || this.switching) {
      this.note("wait until the session is ready");
      return false;
    }
    if (this.listing) {
      this.note("still loading the model list");
      return false;
    }
    if (picker) {
      this.note("choose or cancel the picker first");
      return false;
    }
    if (confirm) {
      this.note("answer the undo question first");
      return false;
    }
    if (this.modeBusy || this.undoBusy || this.invoking || (!allowTurn && (this.turn || phase === "permission"))) {
      this.note("wait for the current turn to finish");
      return false;
    }
    return true;
  }

  /** `/mode`: the mode in effect, or a change to it. */
  mode(arg: string, cmd = "mode"): void {
    if (!this.requireSession() || !this.requireCode(cmd)) return;
    const want = arg.trim().toLowerCase();
    if (!want) {
      this.note(`mode: ${this.state.mode} (change it with /mode plan, /mode build or /mode auto)`);
    } else if (!MODES.includes(want as Mode)) {
      this.note(`unknown mode ${sanitize(want)} \u2014 use plan, build or auto`);
    } else if (want === this.state.mode) {
      this.note(`already in ${want} mode`);
    } else {
      this.setMode(want as Mode); // says "mode: x" once the engine has it
    }
  }

  /** `/todos`: the model's list, as the last `todo_write` left it. */
  async showTodos(): Promise<void> {
    if (!this.requireSession() || !this.requireCode("todos")) return;
    const { todos = [] } = await this.o.bridge.request<{ todos?: TodoItem[] }>("code.todos", {});
    this.set({ todos });
    this.write(fmtTodos(todos, this.o.width()));
  }

  /** `/compact`. */
  compact(): void {
    if (!this.requireSession() || !this.requireCode("compact") || !this.canSwitch() || !this.modelFree()) return;
    this.startStream("code.compact", {}, "compacting\u2026");
  }

  /** `/undo`: show what the last turn changed, then ask. `force` goes over
   *  files that changed after the turn. */
  async undo(force: boolean): Promise<void> {
    if (!this.requireSession() || !this.requireCode("undo") || !this.canSwitch()) return;
    const width = this.o.width();
    this.undoBusy = true;
    try {
      let plan: UndoPlan;
      try {
        plan = normalizePlan(await this.o.bridge.request<UndoPlan>("code.undo", {}));
      } catch (e) {
        return this.undoFailed(e);
      }
      this.write(fmtUndoPlan(plan, width));
      if (plan.conflicts.length > 0) this.write(fmtUndoConflicts(plan, width, !force));
      if (plan.conflicts.length > 0 && !force) return;
      this.set({ confirm: { question: "Undo these changes? (y/N)", detail: undoSummary(plan, false), force } });
    } finally {
      this.undoBusy = false;
      this.drainQueue();
    }
  }

  /** The footer's answer to the open question. */
  async answerConfirm(yes: boolean): Promise<void> {
    const c = this.state.confirm;
    if (!c) return;
    if (!yes) {
      this.set({ confirm: null });
      this.note("nothing was undone");
      this.drainQueue();
      return;
    }
    this.undoBusy = true;
    this.set({ confirm: null });
    try {
      const plan = normalizePlan(await this.o.bridge.request<UndoPlan>("code.undo", c.force ? { confirm: true, force: true } : { confirm: true }));
      if (plan.applied) this.note(`undone: ${undoSummary(plan, true)}`);
      else if (plan.conflicts.length > 0) this.write(fmtUndoConflicts(plan, this.o.width()));
      else this.note("nothing was undone");
    } catch (e) {
      this.undoFailed(e);
    } finally {
      this.undoBusy = false;
      this.drainQueue();
    }
  }

  private undoFailed(e: unknown): void {
    const msg = errText(e);
    if (/^nothing to undo/.test(msg)) this.note("nothing to undo");
    else this.error(msg);
  }

  /** `/clear`: a new session on the same model, mode and opt-ins; under
   *  chat or an agent, a new AIhub conversation (ChatScreen doNewChat). */
  async clear(): Promise<void> {
    if (!this.requireSession() || !this.canSwitch()) return;
    const k = this.state.kind;
    if (k.type !== "code") {
      await this.switchWith(() => this.openHub(k, this.current(), { fresh: true }));
      return;
    }
    await this.replaceSession(() => this.startSession(this.state.model, false, { mode: this.state.mode, fresh: { previous: this.codeResumeId() } }));
  }

  /** `/model [name]`: a new session on another model (the old one stays
   *  resumable). Without a name: a picker of installed and cloud models. */
  async switchModel(name: string): Promise<void> {
    if (!this.canSwitch()) return;
    if (name && this.state.kind.type !== "code") return this.useModel({ name, backend: "ollama" });
    if (name) {
      await this.replaceSession(() => this.startSession(name, true, { mode: this.state.mode, divider: "model" }));
      return;
    }
    this.listing = true;
    this.set({ activity: { label: "loading models\u2026", since: this.now() } });
    try {
      this.openPickerIfFree({ kind: "model", title: "Choose a model", items: await this.modelChoices() });
    } finally {
      this.listing = false;
      this.set({ activity: null });
      this.drainQueue(); // prompts typed meanwhile (the picker, if open, still holds them)
    }
  }

  /** A model picked in the models window: a new code session on it, with its
   *  backend and stream name (the old session stays resumable). Under chat or
   *  an agent, AIhub's way (ChatScreen doPickModel): the conversation is saved
   *  and a new plain chat starts on the new model. */
  async useModel(choice: { name: string; backend: Backend; streamModel?: string }): Promise<void> {
    if (!this.canSwitch()) return;
    if (this.state.kind.type !== "code") {
      const target = { model: choice.name, backend: choice.backend, streamModel: choice.streamModel || choice.name };
      await this.switchWith(async () => {
        const old = this.hub;
        if (old?.hasUserMessages()) await old.finalize(true).catch((e) => this.error(`Saving the chat failed: ${errText(e)}`));
        this.chatCtx = null;
        await this.openHub({ type: "chat" }, target);
      });
      return;
    }
    await this.replaceSession(() =>
      this.startSession(choice.name, false, {
        mode: this.state.mode,
        divider: "model",
        backend: choice.backend,
        streamModel: choice.streamModel,
      }),
    );
  }

  /** `/temp 0.7`, Temperature window, Settings: rounds to 0.1, saves it as the
   *  engine's default (the next turn reads it) and says so. */
  async setTemperature(t: number): Promise<void> {
    const v = Math.round(t * 10) / 10;
    try {
      await this.o.bridge.request("config.set", { patch: { temperature: v } });
    } catch (e) {
      this.error(`Saving the temperature: ${errText(e)}`);
      return;
    }
    this.set({ temperature: v });
    this.note(`Temperature \u2192 ${v.toFixed(1)}.`);
  }

  /** Settings changed something the session shows (AIhub's onPatchSession):
   *  the tools and memory switches, and a context size set by hand. The code
   *  agent's session has its context size from its start, so for it the new
   *  size is for the next session. */
  patchSession(p: { toolsEnabled?: boolean; memoryEnabled?: boolean; contextLength?: number; ctxMax?: number }): void {
    const patch: Partial<ControllerState> = {};
    if (typeof p.toolsEnabled === "boolean") patch.toolsEnabled = p.toolsEnabled;
    if (typeof p.memoryEnabled === "boolean") patch.memoryEnabled = p.memoryEnabled;
    const n = p.contextLength;
    if (typeof n === "number" && n > 0) {
      if (this.state.kind.type === "code") this.note(`Context ${n.toLocaleString()} tokens is saved \u2014 the code agent uses it from its next session (/new).`);
      else patch.ctx = { ...this.state.ctx, limit: n };
    }
    this.set(patch);
  }

  /** Nothing can start a turn while a list loads, but if one did, the picker
   *  would sit over it: drop it and say so. After a failed start ("error",
   *  bridge alive) the picker is the way out, and Esc comes back to "error". */
  private openPickerIfFree(picker: PickerState): void {
    const { phase } = this.state;
    const free = phase === "idle" || (phase === "error" && !this.o.bridge.deadError());
    if (this.turn || !free) {
      this.note("a turn started meanwhile \u2014 try again when it is done");
      return;
    }
    this.openPicker(picker, this.state.sessionId ? null : phase);
  }

  /** Installed models first, then cloud ones that are not installed yet. If
   *  the cloud list cannot be had, the installed ones are still offered. */
  private async modelChoices(): Promise<PickerItem[]> {
    const { models = [] } = await this.o.bridge.request<{ models?: { name: string }[] }>("models.installed", {});
    const items: PickerItem[] = models.map((m) => ({ id: String(m.name), label: String(m.name) }));
    try {
      const { models: cloud = [] } = await this.o.bridge.request<{ models?: { name: string; status?: string; installed?: boolean }[] }>("cloud.models", {});
      const have = new Set(items.map((i) => i.id));
      for (const m of cloud) {
        if (m.installed || have.has(m.name) || m.status === "retired" || m.status === "missing") continue;
        items.push({ id: String(m.name), label: `${m.name} (cloud${m.status === "free" || m.status === "paid" ? `, ${m.status}` : ""})` });
      }
    } catch {
      this.note("could not load the cloud list \u2014 showing installed models");
    }
    return items;
  }

  /** `/sessions`, `/resume`: pick one of this folder's earlier sessions. */
  async openSessions(cmd = "sessions"): Promise<void> {
    if (!this.requireCode(cmd) || !this.canSwitch()) return;
    this.listing = true;
    try {
      const { sessions = [] } = await this.o.bridge.request<{ sessions?: any[] }>("code.sessions", { cwd: this.o.cwd ?? process.cwd() });
      const others = sessions.filter((s) => String(s.id) !== this.state.sessionId);
      if (others.length === 0) {
        this.note("no earlier session in this folder");
        return;
      }
      this.openPickerIfFree({
        kind: "session",
        title: "Resume a session",
        items: others.map((s) => ({ id: String(s.id), label: sessionLabel(s) })),
      });
    } finally {
      this.listing = false;
      this.drainQueue();
    }
  }

  /** `/resume <id>`. */
  async resumeSession(id: string): Promise<void> {
    if (!this.requireCode("resume") || !this.canSwitch()) return;
    if (id === this.state.sessionId) {
      this.note("that's the current session");
      return;
    }
    await this.replaceSession(() => this.resume(id));
  }

  /** The session worth resuming: one something was said in (or that was itself
   *  resumed). Empty otherwise. The app prints the resume line from this once
   *  the terminal is restored. */
  resumableSessionId(): string {
    // Under chat or an agent the code session's line is in the transcript
    // already (written when it went behind); it is written once.
    const id = this.codeResumeId();
    return id && !this.resumeLineShown.has(id) ? id : "";
  }

  /** The code session in front, if it is worth resuming (it had a turn, or
   *  was resumed), whether or not its line was written already: a fresh screen
   *  (/new, /clear) clears that line, and then it is written again. */
  private codeResumeId(): string {
    if (this.state.kind.type !== "code") return "";
    return this.state.sessionId && (this.turnsSent > 0 || this.resumed) ? this.state.sessionId : "";
  }

  // ── memory and skills ──────────────────────────────────────────────────────

  /** `/skill <name> [task]`: the skill's instructions (skills.invoke, sized
   *  to the context in use) go to the model as the prompt; the transcript
   *  keeps what was typed (the command's echo). Between turns only. */
  async useSkill(name: string, task: string): Promise<void> {
    if (!this.requireSession() || !this.canSwitch() || !this.modelFree()) return;
    this.invoking = true;
    let content: string;
    try {
      const d = await this.o.bridge.request<{ content?: string }>("skills.invoke", { name, task, context_length: this.contextLength() });
      content = String(d?.content ?? "");
    } catch (e) {
      this.invoking = false;
      if (!(this.o.bridge.deadError() && this.state.phase === "error")) this.error(`Using skill ${name} failed: ${errText(e)}`);
      this.drainQueue();
      return;
    }
    this.invoking = false;
    if (this.exited) return;
    const dead = this.o.bridge.deadError();
    if (dead) return this.bridgeGone(dead);
    this.sendTurn(`/skill ${name}`, content);
  }

  /** The conversation in front, as memory.extract reads it: the AIhub chat's
   *  messages, or the code conversation's user messages. */
  conversationMessages(): unknown[] {
    return this.state.kind.type !== "code" && this.hub ? this.hub.messages : this.learner.codeMessages();
  }

  // ── images ─────────────────────────────────────────────────────────────────

  /** Can the model in front read images? Asked once per model. */
  private async canSee(): Promise<boolean> {
    const s = this.state;
    const key = `${s.backend}:${s.streamModel || s.model}`;
    let ok = this.vision.get(key);
    if (ok === undefined) {
      const d = await this.o.bridge.request<{ vision?: boolean }>("vision.check", { model: s.model, stream_model: s.streamModel || s.model, backend: s.backend });
      ok = !!d?.vision;
      // Only a yes is kept: the engine answers no when Ollama is slow to say.
      if (ok) this.vision.set(key, true);
    }
    if (!ok) this.error(`${s.model} can't see images \u2014 pick a vision model (/model), e.g. gemma4:cloud`);
    return ok;
  }

  private addImages(list: Attachment[]): void {
    let full = false;
    for (const a of list) if (!this.attachments.add(a)) full = true;
    this.set({ images: this.attachments.list() });
    if (full) this.note("at most 8 images per message");
  }

  /** Text that is only image paths (typed + Enter, or pasted): attach them.
   *  True: the text was spoken for (attached, refused for a model that can't
   *  see, or failed) and must not be sent or pasted. False: it was not image
   *  files: the caller goes on with it as typed. */
  async attachPaths(text: string): Promise<boolean> {
    try {
      if (!(await this.canSee())) return true;
      const d = await this.o.bridge.request<{ attachments?: Attachment[] }>("attach.paste", { text });
      const got = d?.attachments ?? [];
      if (got.length) this.addImages(got);
      return got.length > 0;
    } catch (e) {
      this.error(`Attaching the image: ${errText(e)}`);
      return true; // an image that failed is not sent as text
    }
  }

  /** Ctrl+V with an image in the clipboard. */
  async attachClipboard(): Promise<void> {
    try {
      if (!(await this.canSee())) return;
      const d = await this.o.bridge.request<{ attachment?: Attachment }>("attach.clipboard");
      if (d?.attachment) this.addImages([d.attachment]);
    } catch (e) {
      this.error(`Attaching the clipboard image: ${errText(e)}`);
    }
  }

  removeLastImage(): void {
    if (!this.attachments.removeLast()) return;
    this.set({ images: this.attachments.list() });
  }

  /** A new conversation (clear, another model or kind): its images go. */
  private dropImages(): void {
    if (!this.attachments.list().length) return;
    this.attachments.clear();
    this.set({ images: [] });
  }

  /** Put text into the prompt box (the skills window's "use"). */
  prefill(text: string): void {
    this.set({ prefill: { text, seq: (this.state.prefill?.seq ?? 0) + 1 } });
  }

  /** The skills for the footer's suggestions (AIhub refreshes them at start). */
  async refreshSkills(): Promise<void> {
    try {
      const d = await this.o.bridge.request<{ skills?: { name: string; description?: string; enabled?: boolean }[] }>("skills.list", {});
      this.skillsChanged(Array.isArray(d?.skills) ? d.skills : []);
    } catch (e) {
      if (!this.exited && !this.o.bridge.deadError()) this.error(`Listing skills failed: ${errText(e)}`);
    }
  }

  /** The skills window changed them (its onChanged). */
  skillsChanged(list: { name: string; description?: string; enabled?: boolean }[]): void {
    this.set({ skills: list.filter((s) => s.enabled !== false).map((s) => ({ name: String(s.name), description: String(s.description ?? "") })) });
  }

  // ── knowledge bases and MCP ────────────────────────────────────────────────

  /** The bases for `/kb` and its suggestions (AIhub's refreshKb). */
  async refreshKb(): Promise<void> {
    try {
      const d = await this.o.bridge.request<{ bases?: { name: string; description?: string }[] }>("kb.list", {});
      this.kbList = (Array.isArray(d?.bases) ? d.bases : []).map((b) => ({ name: String(b.name), description: String(b.description ?? "") }));
      this.set({ kbNames: this.kbList.map((b) => b.name) });
    } catch (e) {
      if (!this.exited && !this.o.bridge.deadError()) this.error(`Listing knowledge bases failed: ${errText(e)}`);
    }
  }

  /** The knowledge window closed: it may have made, changed or deleted bases. */
  knowledgeClosed(): void {
    void this.refreshKb();
  }

  /** The connections window closed. Under the code agent its MCP follows the
   *  servers: on while any is enabled. (An AIhub chat picks the tools per
   *  message from the enabled servers itself.) */
  mcpClosed(): void {
    if (this.state.kind.type === "code") void this.syncMcp();
  }

  private async syncMcp(): Promise<void> {
    if (!this.state.sessionId) return;
    try {
      const d = await this.o.bridge.request<{ servers?: { enabled?: boolean }[] }>("mcp.list", {});
      const on = (Array.isArray(d?.servers) ? d.servers : []).some((x) => x.enabled !== false);
      if (on === this.wantedOpts().mcp) return;
      this.optsTouched = true;
      this.codeOptions({ mcp: on });
    } catch (e) {
      if (!this.exited && !this.o.bridge.deadError()) this.error(`Reading the connections failed: ${errText(e)}`);
    }
  }

  /** What the code session will have once a waiting change is in. */
  private wantedOpts(): { mcp: boolean; knowledge: string[] } {
    const p = this.pendingOpts;
    return { mcp: p?.mcp ?? this.codeOpts.mcp, knowledge: [...(p?.knowledge ?? this.codeOpts.knowledge)] };
  }

  /** Ask the code session for other options. The engine refuses while a turn
   *  runs, so then it waits (`done` says its note afterwards). */
  private codeOptions(change: { mcp?: boolean; knowledge?: string[] }, done?: () => void): void {
    const p = this.pendingOpts ?? { done: [] };
    this.pendingOpts = { ...p, ...change, done: done ? [...p.done, done] : p.done };
    void this.flushOptions();
  }

  private async flushOptions(): Promise<void> {
    if (this.optsBusy) return;
    this.optsBusy = true;
    try {
      while (this.pendingOpts && this.canFlushOptions()) {
        const { done, ...change } = this.pendingOpts;
        this.pendingOpts = null;
        try {
          const r = await this.o.bridge.request<{ mcp?: boolean; knowledge?: string[] }>("code.options", change);
          this.codeOpts = {
            mcp: typeof r?.mcp === "boolean" ? r.mcp : (change.mcp ?? this.codeOpts.mcp),
            knowledge: Array.isArray(r?.knowledge) ? r.knowledge.map(String) : (change.knowledge ?? this.codeOpts.knowledge),
          };
          this.set({ mcp: this.codeOpts.mcp, ...(this.state.kind.type === "code" ? { knowledge: [...this.codeOpts.knowledge] } : {}) });
          for (const f of done) f();
        } catch (e) {
          if (!this.exited && !this.o.bridge.deadError()) this.error(errText(e));
        }
      }
    } finally {
      this.optsBusy = false;
      // A turn that started meanwhile ends in drainQueue, which comes back here.
      // The queue waited behind the change: let it go now.
      if (this.canFlushOptions()) this.drainQueue();
    }
  }

  private canFlushOptions(): boolean {
    return !this.turn && !this.switching && this.state.phase !== "starting" && !!this.state.sessionId;
  }

  /** `/kb`: list the bases, `/kb <name…>` switches them on for this chat,
   *  `/kb off` stops (AIhub's applyKb, same texts). The code agent's go
   *  through code.options; an AIhub chat's are sent with each turn. */
  applyKb(arg: string): void {
    if (!this.requireSession()) return;
    const hub = this.state.kind.type === "code" ? null : this.hub;
    const on = hub ? hub.knowledge : this.wantedOpts().knowledge;
    const use = (next: string[], text: string) => {
      this.optsTouched = true;
      if (hub) {
        hub.knowledge = next;
        this.set({ knowledge: [...next] });
        this.note(text);
      } else {
        this.codeOptions({ knowledge: next }, () => this.note(text));
      }
    };
    if (!arg) {
      if (!this.kbList.length) return this.note("No knowledge bases yet \u2014 /knowledge (F6) makes one from your documents.");
      return this.note(
        "Knowledge bases: " +
          this.kbList.map((b) => `${on.includes(b.name) ? "\u2713 " : ""}${b.name}${b.description ? ` (${b.description})` : ""}`).join(" \u00b7 ") +
          (on.length ? `\nActive here: ${on.join(", ")} \u2014 /kb off to stop.` : "\nUse one here: /kb <name>."),
      );
    }
    if (arg === "off") return use([], "Knowledge off for this chat.");
    const names = arg.split(/[\s,]+/).filter(Boolean);
    const unknown = names.filter((n) => !this.kbList.some((b) => b.name === n));
    if (unknown.length) return this.error(`No knowledge base called ${unknown.join(", ")} \u2014 /kb lists them.`);
    const next = [...new Set([...on, ...names])];
    use(next, `\u00b6 Using ${next.join(", ")} in this chat \u2014 answers draw on those documents and cite them [1]. /kb off stops.`);
  }

  // ── kinds: the code agent, plain chat, AIhub agents ────────────────────────

  /** `/agent code|chat|<profile>`, the agents window. A running turn is
   *  interrupted first (its queued prompts are dropped, as on Esc); an agent
   *  is checked (agent.check) before anything changes. Leaving the code agent
   *  writes its resume line; chat and an agent share one AIhub conversation
   *  (AIhub's mode switch); back to code, the code session goes on (a new one
   *  if the model changed meanwhile). */
  async setKind(k: Kind): Promise<void> {
    if (this.exited || !this.requireSession()) return;
    const cur = this.state.kind;
    if (sameKind(cur, k)) {
      this.note(`already ${k.type === "chat" ? "in plain chat" : k.type === "code" ? "with the code agent" : `with agent ${k.name} \u00b7 ${k.submode}`}`);
      return;
    }
    if (!this.canSwitch(true)) return;
    await this.switchWith(async () => {
      // The agent is checked before anything changes: a profile that can't
      // run (a typo) leaves the running turn and its queue alone. agent.check
      // asks no model for an answer, so it may overlap a turn.
      let check: AgentCheck = {};
      if (k.type === "agent") {
        const { model, streamModel, backend } = this.state;
        check = (await this.o.bridge.request<AgentCheck>("agent.check", { model: streamModel || model, backend, agent: k.name })) ?? {};
        if (!check.ok) {
          this.error(`Agent unavailable: ${check.reason ?? "unknown reason"}`);
          return;
        }
      }
      // The turn running now (one may have ended during the check).
      const turn = this.turn;
      if (turn) {
        this.cancel(); // writes "interrupted" and drops what was queued behind it
        await turn.handle?.done.then(noop, noop);
        if (this.o.bridge.deadError()) return; // onFail has said it
        this.set({ phase: "starting" });
      } else {
        this.dropQueued();
        if (this.state.phase === "idle") this.set({ phase: "starting" });
      }
      if (cur.type === "code") this.leaveCode();
      if (k.type === "code") await this.enterCode();
      else if (cur.type !== "code" && this.hub) await this.changeHubKind(k, check);
      else await this.openHub(k, this.current(), { check });
    });
  }

  /** A conversation from AIhub's history (the history window): it continues
   *  under chat (or under the agent in front, as AIhub keeps its mode). */
  async loadHistory(messages: ChatMessage[], startTime?: string): Promise<boolean> {
    if (this.exited || !this.requireSession() || !this.canSwitch()) return false;
    let loaded = false;
    await this.switchWith(async () => {
      const cur = this.state.kind;
      const k: HubKind = cur.type === "code" ? { type: "chat" } : cur;
      if (cur.type === "code") this.leaveCode();
      const m = this.current();
      const hub = new HubChat(this.o.bridge, m);
      hub.load(messages, startTime);
      hub.kind = k;
      const limit = cur.type === "code" ? await this.chatContext(m) : this.state.ctx.limit;
      // Old messages were already there to learn from; only new ones count.
      this.learner.reset(messages.filter((x) => x.role === "user").length);
      this.hub = hub;
      this.set({ kind: k, ctx: { used: 0, limit }, knowledge: [] });
      this.write(fmtDivider(kindHeader(k, this.state.mode, m.model), this.o.width()));
      this.o.onResume?.(messages);
      const n = messages.filter((x) => x.role === "user" || x.role === "assistant").length;
      this.note(`Resumed session \u2014 ${n} messages.`);
      loaded = true;
    });
    return loaded;
  }

  private current(): { model: string; backend: Backend; streamModel: string } {
    const { model, backend, streamModel } = this.state;
    return { model, backend, streamModel: streamModel || model };
  }

  /** A switch: "starting" meanwhile (prompts typed queue), a failure said and
   *  the kind left as it was, the queue served afterwards. */
  private async switchWith(fn: () => Promise<void>): Promise<void> {
    this.switching = true;
    if (!this.turn) this.set({ phase: "starting" });
    try {
      await fn();
    } catch (e) {
      const dead = this.o.bridge.deadError();
      if (dead) this.bridgeGone(dead);
      else this.error(errText(e));
    } finally {
      this.switching = false;
      if (this.state.phase === "starting") this.set({ phase: "idle" });
      this.drainQueue();
    }
  }

  private dropQueued(): void {
    const n = this.state.queue.length;
    if (n === 0) return;
    this.note(`dropped ${n} queued prompt${n === 1 ? "" : "s"}`);
    this.queuedImages = [];
    this.set({ queue: [] });
  }

  /** The code session goes behind: its resume line (once), and what to come back to. */
  private leaveCode(): void {
    const id = this.resumableSessionId();
    if (id) {
      this.resumeLineShown.add(id);
      this.note(exitLine(id)!);
    }
    const { model, backend, streamModel, ctx } = this.state;
    this.codeSnap = { model, backend, streamModel, ctx, resume: this.codeResumeId() };
  }

  private async enterCode(): Promise<void> {
    // An interrupted chat turn was not saved yet: the conversation ends here.
    const old = this.hub;
    if (old?.unsaved) await old.finalize(true).catch((e) => this.error(`Saving the chat failed: ${errText(e)}`));
    const snap = this.codeSnap;
    const m = this.current();
    if (snap && snap.model === m.model && snap.backend === m.backend && (snap.streamModel || snap.model) === m.streamModel) {
      this.learner.reset(); // the AIhub conversation ends
      this.dropImages();
      this.set({ kind: CODE, ctx: snap.ctx, knowledge: [...this.codeOpts.knowledge] });
      this.write(fmtDivider(kindHeader(CODE, this.state.mode, m.model), this.o.width()));
      void this.syncMcp(); // /mcp may have changed while another kind was in front
    } else {
      await this.startSession(m.model, false, { mode: this.state.mode, divider: "model", backend: m.backend, streamModel: m.streamModel });
      this.set({ kind: CODE, knowledge: [...this.codeOpts.knowledge] });
    }
    this.hub = null;
    this.codeSnap = null;
    this.chatCtx = null;
  }

  /** A new AIhub conversation (chat.start) of kind `k` on model `m`. */
  private async openHub(
    k: HubKind,
    m: { model: string; backend: Backend; streamModel: string },
    o: { check?: AgentCheck; fresh?: boolean } = {},
  ): Promise<void> {
    const hub = new HubChat(this.o.bridge, m);
    await hub.start();
    hub.kind = k;
    let limit = this.state.ctx.limit;
    if (k.type === "chat") limit = await this.chatContext(m);
    else if (Number(o.check?.context) > 0) limit = Number(o.check!.context);
    this.learner.reset();
    this.dropImages();
    this.hub = hub;
    // A new chat starts with no knowledge bases (AIhub's new chat does).
    this.set({ kind: k, model: m.model, backend: m.backend, streamModel: m.streamModel, ctx: { used: 0, limit }, knowledge: [] });
    if (o.fresh) this.o.onFresh?.();
    this.write(fmtDivider(kindHeader(k, this.state.mode, m.model), this.o.width()));
    // A fresh screen cleared the code session's resume line (written when it
    // went behind): say it again, so the id is on the screen.
    if (o.fresh && this.codeSnap?.resume) this.note(`Previous session: aihub-code --resume ${this.codeSnap.resume}`);
    // On entering an agent (not on /clear under it): what it can do.
    if (k.type === "agent" && o.check) this.note(agentNote(o.check.agent ?? { name: k.name }, k.submode, o.check, m.model, limit));
  }

  /** Chat ↔ agent (or another agent) inside the same AIhub conversation. */
  private async changeHubKind(k: HubKind, check: AgentCheck): Promise<void> {
    const cur = this.state.kind;
    let limit = this.state.ctx.limit;
    if (k.type === "agent") {
      if (cur.type === "chat") this.chatCtx = limit;
      if (Number(check.context) > 0) limit = Number(check.context);
    } else {
      limit = this.chatCtx ?? (await this.chatContext(this.current()));
      this.chatCtx = null;
    }
    this.hub!.kind = k;
    this.set({ kind: k, ctx: { ...this.state.ctx, limit } });
    this.write(fmtDivider(kindHeader(k, this.state.mode, this.state.model), this.o.width()));
    if (k.type === "agent") this.note(agentNote(check.agent ?? { name: k.name }, k.submode, check, this.state.model, limit));
    else this.note("Back to plain chat.");
  }

  /** Plain chat's context: what fits this model (AIhub sizes it so on
   *  picking a model); otherwise the size in use, or AIhub's default. */
  private async chatContext(m: { model: string; backend: Backend }): Promise<number> {
    const fallback = this.state.ctx.limit > 0 ? this.state.ctx.limit : this.defaultContext;
    if (m.backend !== "ollama") return fallback;
    try {
      const d = await this.o.bridge.request<{ context?: number }>("hardware.recommend_context", { model: m.model });
      return Number(d?.context) > 0 ? Number(d.context) : fallback;
    } catch {
      return fallback;
    }
  }

  /** Leave. A running turn is interrupted first, and its end awaited for a
   *  moment: the engine saves the session then, so --resume has the last
   *  prompt; an AIhub chat whose last turn was interrupted is saved to
   *  history then (AIhub's quit). A dead bridge rejects at once; a stuck one
   *  is not waited for. */
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.learner.cancel(); // AIhub's quit drops a pending learn too
    // No new task starts; a running one is cancelled (the routed chat.cancel)
    // and its end awaited like a turn's, so the engine records it.
    const taskRunning = this.scheduler?.isRunning() ?? null;
    const taskStop = this.scheduler?.stop() ?? null;
    const turn = this.turn;
    if (!turn?.handle && !this.pendingOpts && !taskRunning && !this.hub?.unsaved) return this.o.onExit?.();
    if (turn?.handle) this.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((r) => (timer = setTimeout(r, this.o.exitGraceMs ?? 1500)));
    void (async () => {
      const ends: Promise<unknown>[] = [];
      if (turn?.handle) ends.push(turn.handle.done.then(noop, noop));
      if (taskRunning && taskStop) ends.push(taskStop);
      if (ends.length) await Promise.race([Promise.all(ends), grace]);
      // The interrupted turn's conversation (now, or an earlier Esc) goes to history.
      const hub = this.hub;
      if (hub?.unsaved && !this.o.bridge.deadError()) await Promise.race([hub.finalize(true).catch(noop), grace]);
      // A /kb or /mcp change still waiting is applied (and saved) before leaving.
      if (this.pendingOpts) {
        if (this.canFlushOptions()) await Promise.race([this.flushOptions(), grace]);
        if (this.pendingOpts) this.note("The /kb and /mcp change was not applied \u2014 the session ended first.");
      }
      clearTimeout(timer);
      this.o.onExit?.();
    })();
  }
}

const noop = (): void => {};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function normalizePlan(p: Partial<UndoPlan> | null | undefined): UndoPlan {
  return {
    restore: list(p?.restore),
    delete: list(p?.delete),
    conflicts: list(p?.conflicts),
    shell_not_reverted: list(p?.shell_not_reverted),
    skipped: list(p?.skipped),
    applied: p?.applied === true,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "fix calc (3 turns, 2026-10-26 10:00)". */
function sessionLabel(s: any): string {
  const when = String(s.updated ?? "").replace("T", " ").slice(0, 16);
  const turns = Number(s.turns) || 0;
  const title = String(s.title || "(no title)");
  return `${title} (${turns} turn${turns === 1 ? "" : "s"}${when ? `, ${when}` : ""})`;
}

function activityFor(ev: ToolCallEvent): string {
  if (SHELL_TOOLS.has(ev.name)) {
    const cmd = typeof ev.arguments?.command === "string" ? ev.arguments.command : "";
    const first = sanitize(stripCR(cmd.split("\n")[0] ?? "")).trim();
    if (first) return `running ${first}…`;
  }
  return `running ${sanitize(ev.name)}…`;
}
