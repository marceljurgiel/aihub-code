/**
 * Scheduled tasks while aihub-code is open: SchedulerHost runs AIhub's clock
 * (hub/schedule/useScheduler.ts) next to the footer, and the controller gates
 * it — one model request at a time on the user's server.
 *
 * Includes two of AIhub v1.5.0's ChatScreen-level tests (schedule.test.tsx),
 * rewritten against the app and the controller: "the Schedule window follows
 * a running task: r cancels it…" and "a task's result opens without empty
 * reply blocks for tool-only rounds".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { Args } from "../args";
import { launch, type Launched } from "../app";
import { until } from "../footer/test-utils";
import { schedulerTiming } from "../hub/schedule/useScheduler";
import { MockBridge, type MockStream } from "../session/mock-bridge";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const INFO = {
  session_id: "s1",
  project: { root: "/home/alex/proj", branch: "main", is_git: true },
  mode: "build",
  model: "m",
  context_length: 1000,
};
const SLOT = "2026-10-30T08:00:00";

const DIGEST = {
  name: "mail-digest", agent: "mail", model: "llama3.2:3b", backend: "ollama", stream_model: "llama3.2:3b",
  when: "daily 08:00", prompt: "Summarize today's unread email for alex.", enabled: true,
  created: "2026-10-01T09:00:00", broken: "", path: "/home/alex/.aihub/schedule/mail-digest.md",
  next_run: "2026-10-31T08:00:00", last_run: "2026-10-30T08:00:05", last_status: "ok",
  last_summary: "Three new emails.", last_error: "",
  last_session: { model: "llama3.2:3b", filename: "2026-10-30_08-00-05.json" },
};

/** The engine's schedule.check answers what the test puts in `due` (once)
 *  and, at start-up, `missed`. */
class TaskBridge extends MockBridge {
  destroyed = 0;
  due: { name: string; slot: string }[] = [];
  missed: { name: string; when: string; slot: string }[] = [];
  constructor() {
    super();
    this.answers["schedule.check"] = (p: Record<string, unknown>) => {
      if (p.startup) return { due: [], missed: this.missed };
      const due = this.due;
      this.due = [];
      return { due, missed: [] };
    };
    this.answers["schedule.list"] = { tasks: [{ ...DIGEST }] };
    this.answers["agents.list"] = { agents: [{ name: "mail", description: "Reads your mail", builtin: true }] };
  }
  destroy() {
    this.destroyed++;
  }
  runs(): MockStream[] {
    return this.streams.filter((s) => s.method === "schedule.run");
  }
  turns(): MockStream[] {
    return this.streams.filter((s) => s.method === "code.turn");
  }
  count(method: string): number {
    return this.to(method).length;
  }
}

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;
let open: { setup: Setup; app: Launched } | undefined;
beforeEach(() => {
  schedulerTiming.checkMs = 40;
});
afterEach(() => {
  open?.setup.renderer.destroy();
  open = undefined;
  schedulerTiming.checkMs = 30_000;
});

async function run(o: { bridge?: TaskBridge; answers?: Record<string, unknown> } = {}) {
  const setup = await createTestRenderer({
    width: 120,
    height: 36,
    screenMode: "split-footer",
    footerHeight: 5,
    externalOutputMode: "capture-stdout",
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const resets: unknown[] = [];
  setup.renderer.resetSplitFooterForReplay = (opts) => {
    resets.push(opts ?? {});
    setup.externalOutput.clear();
  };
  const bridge = o.bridge ?? new TaskBridge();
  bridge.answers["config.get"] = { default_chat_model: "m" };
  bridge.answers["code.start"] = INFO;
  bridge.answers["models.installed"] = { models: [{ name: "m" }] };
  Object.assign(bridge.answers, o.answers ?? {});
  const closed: (string | null)[] = [];
  const app = launch({ renderer: setup.renderer, bridge, args: ARGS, cwd: "/home/alex/proj", home: "/home/alex", onClosed: (l) => closed.push(l), resizeQuietMs: 30 });
  open = { setup, app };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await sleep(15);
      await setup.renderOnce();
    }
  };
  const frame = () => setup.captureCharFrame().split("\n").map((l) => l.trimEnd()).join("\n");
  /** Everything written to the transcript so far, one string per line. */
  const text = () => app.transcript.all().map((l) => l.map((s) => s.text).join(""));
  const submit = async (line: string) => {
    await setup.mockInput.typeText(line);
    setup.mockInput.pressEnter();
    await settle();
  };
  await until(() => app.controller.getState().phase === "idle", settle);
  return { setup, app, bridge, closed, resets, settle, frame, text, submit };
}

describe("scheduled tasks in the background", () => {
  test("a due task starts schedule.run; its events print as a block; a prompt sent meanwhile waits for it", async () => {
    const t = await run();
    t.bridge.due = [{ name: "daily", slot: SLOT }];
    await until(() => t.bridge.runs().length === 1, t.settle);
    const r = t.bridge.runs()[0]!;
    expect(r.params).toEqual({ name: "daily", slot: SLOT });
    expect(t.app.controller.getState().taskRunning).toBe("daily");
    await until(() => t.frame().includes("task daily…"), t.settle); // the status line says so
    r.emit("task", { name: "daily", phase: "started" });
    r.emit("tool_call", { name: "read_file", arguments: { path: "notes.md" } });
    r.emit("tool_result", { name: "read_file", arguments: { path: "notes.md" }, result: "three notes" });
    r.emit("round", { text: "" });
    r.emit("text", { text: "Hi there, three notes today.\n" });
    r.emit("round", { text: "Hi there, three notes today." });

    await t.submit("what's new?");
    expect(t.text().join("\n")).toContain("Waiting for task daily… your message goes right after.");
    expect(t.bridge.turns()).toHaveLength(0);
    expect(t.app.controller.getState().queue).toEqual(["what's new?"]);

    r.finish({ status: "ok", summary: "Hi there.", session: null });
    await until(() => t.bridge.turns().length === 1, t.settle);
    expect(t.bridge.turns()[0]!.params.text).toBe("what's new?");
    expect(t.app.controller.getState().taskRunning).toBeNull();
    const lines = t.text();
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(lines.some((l) => /^── task daily ─+$/.test(l))).toBe(true);
    expect(at("task daily ──")).toBeLessThan(at("read_file notes.md"));
    expect(at("read_file notes.md")).toBeLessThan(at("Hi there, three notes today."));
    expect(at("Hi there, three notes today.")).toBeLessThan(at("Task daily finished — /schedule to see it."));
    expect(at("Task daily finished")).toBeLessThan(at("> what's new?"));
    expect(lines.filter((l) => l.includes("Hi there, three notes today."))).toHaveLength(1);
    await until(() => !t.frame().includes("task daily…"), t.settle);
  });

  test("a task due while a turn runs waits for the turn", async () => {
    const t = await run();
    await t.submit("hello");
    await until(() => t.bridge.turns().length === 1, t.settle);
    t.bridge.due = [{ name: "daily", slot: SLOT }];
    const checks = t.bridge.count("schedule.check");
    await until(() => t.bridge.count("schedule.check") >= checks + 3, t.settle);
    expect(t.bridge.runs()).toHaveLength(0); // the turn has the model
    t.bridge.turns()[0]!.finish({});
    await until(() => t.bridge.runs().length === 1, t.settle);
    expect(t.bridge.runs()[0]!.params).toEqual({ name: "daily", slot: SLOT });
  });

  test("a held prompt and the next queued task never run together", async () => {
    const t = await run();
    t.bridge.due = [
      { name: "a", slot: SLOT },
      { name: "b", slot: SLOT },
    ];
    await until(() => t.bridge.runs().length === 1, t.settle);
    await t.submit("hi");
    t.bridge.runs()[0]!.finish({ status: "ok", summary: "", session: null });
    await until(() => t.bridge.turns().length === 1, t.settle); // the held prompt goes first
    await sleep(200);
    await t.settle();
    expect(t.bridge.runs()).toHaveLength(1); // b waits for the reply
    t.bridge.turns()[0]!.finish({});
    await until(() => t.bridge.runs().length === 2, t.settle);
    expect(t.bridge.runs()[1]!.params.name).toBe("b");
  });

  test("a task waits while a memory learn has the model", async () => {
    let release: (v: unknown) => void = () => {};
    const t = await run({ answers: { "memory.learn": () => new Promise((r) => (release = r)) } });
    await t.submit("I work in Rust");
    t.bridge.turns()[0]!.finish({ messages: [{ role: "user", content: "I work in Rust" }, { role: "assistant", content: "Noted." }] });
    await until(() => t.bridge.count("memory.learn") === 1, t.settle);
    t.bridge.due = [{ name: "daily", slot: SLOT }];
    const checks = t.bridge.count("schedule.check");
    await until(() => t.bridge.count("schedule.check") >= checks + 3, t.settle);
    expect(t.bridge.runs()).toHaveLength(0);
    release({ changes: [], cursor: 1 });
    await until(() => t.bridge.runs().length === 1, t.settle);
  });

  test("a task waits while /memoryadd's memory.extract has the model", async () => {
    let release: (v: unknown) => void = () => {};
    const t = await run({ answers: { "memory.extract": () => new Promise((r) => (release = r)) } });
    await t.submit("I work in Rust");
    t.bridge.turns()[0]!.finish({ messages: [{ role: "user", content: "I work in Rust" }, { role: "assistant", content: "Noted." }] });
    await t.settle();
    await t.submit("/memoryadd");
    await until(() => t.bridge.count("memory.extract") === 1, t.settle);
    t.bridge.due = [{ name: "daily", slot: SLOT }];
    const checks = t.bridge.count("schedule.check");
    await until(() => t.bridge.count("schedule.check") >= checks + 3, t.settle);
    expect(t.bridge.runs()).toHaveLength(0); // the extract has the model
    release({ ok: true });
    await until(() => t.bridge.runs().length === 1, t.settle);
    expect(t.text().join("\n")).toContain("Memory updated with extracted facts.");
  });

  test("/schedule run <name> runs it now; an unknown name says so", async () => {
    const t = await run();
    await t.submit("/schedule run mail-digest");
    await until(() => t.bridge.runs().length === 1, t.settle);
    expect(t.bridge.runs()[0]!.params).toEqual({ name: "mail-digest" });
    expect(t.text().join("\n")).toContain("Running task mail-digest…");
    await t.submit("/schedule run nope");
    await until(() => t.text().join("\n").includes("No task named nope — /schedule to see tasks."), t.settle);
    expect(t.bridge.runs()).toHaveLength(1);
    await t.submit("/schedule now");
    expect(t.text().join("\n")).toContain("usage: /schedule, or /schedule run <name>");
  });

  test("missed runs open the missed panel at start-up: Enter runs, s skips, then the clock starts", async () => {
    const bridge = new TaskBridge();
    bridge.missed = [
      { name: "mail-digest", when: "daily 08:00", slot: "2026-10-29T08:00:00" },
      { name: "kb-report", when: "weekly Mon 09:00", slot: "2026-10-26T09:00:00" },
    ];
    const t = await run({ bridge });
    await until(() => t.frame().includes("Missed while AIhub was closed") && t.frame().includes("mail-digest"), t.settle);
    expect(t.app.controller.getState().panel?.id).toBe("missed");
    expect(t.frame()).toContain("Missed task 1/2");
    expect(bridge.count("schedule.check")).toBe(1); // no periodic checks while asking
    await sleep(250);
    t.setup.mockInput.pressEnter();
    await until(() => t.frame().includes("kb-report") && t.frame().includes("weekly Mon 09:00"), t.settle);
    await sleep(250);
    t.setup.mockInput.pressKey("s");
    await until(() => bridge.count("schedule.skip") === 1, t.settle);
    expect(bridge.to("schedule.skip")[0]!.params).toEqual({ name: "kb-report", slot: "2026-10-26T09:00:00" });
    await until(() => bridge.runs().length === 1, t.settle);
    expect(bridge.runs()[0]!.params).toEqual({ name: "mail-digest", slot: "2026-10-29T08:00:00" });
    expect(t.app.controller.getState().panel).toBeNull();
    await until(() => bridge.count("schedule.check") >= 2, t.settle); // the clock starts after
  });

  // AIhub v1.5.0 schedule.test.tsx, rewritten against the controller.
  test("the Schedule window follows a running task: r cancels it, the list refreshes when it ends", async () => {
    const t = await run();
    await t.submit("/schedule");
    await until(() => t.frame().includes("mail-digest"), t.settle);
    t.bridge.due = [{ name: "mail-digest", slot: SLOT }];
    await until(() => t.frame().includes("► running…") && t.frame().includes("cancel"), t.settle);
    t.setup.mockInput.pressKey("r");
    await until(() => t.frame().includes("Cancelled task mail-digest."), t.settle);
    const r = t.bridge.runs()[0]!;
    expect(t.bridge.controls).toContainEqual({ method: "chat.cancel", params: { request_id: r.id } });
    const lists = t.bridge.count("schedule.list");
    r.finish({ status: "cancelled", summary: "", session: null });
    await until(() => !t.frame().includes("► running…") && t.bridge.count("schedule.list") > lists, t.settle);
  });

  // AIhub v1.5.0 schedule.test.tsx, rewritten against the controller.
  test("a task's result opens without empty reply blocks for tool-only rounds", async () => {
    const t = await run({
      answers: {
        "history.load": {
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "List the functions in inventory.py." },
            { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "inventory.py" } } }] },
            { role: "tool", content: "def total_value(items): ..." },
            { role: "assistant", content: "total_value sums the stock." },
          ],
          start_time: "2026-10-30T08:00:05",
        },
      },
    });
    await t.submit("/schedule");
    await until(() => t.frame().includes("mail-digest"), t.settle);
    await sleep(250);
    t.setup.mockInput.pressEnter(); // ↵ result
    await until(() => t.text().join("\n").includes("total_value sums the stock."), t.settle);
    expect(t.bridge.to("history.load")[0]!.params).toEqual({ model: "llama3.2:3b", filename: "2026-10-30_08-00-05.json" });
    const lines = t.text();
    expect(lines.filter((l) => l.includes("total_value sums the stock."))).toHaveLength(1);
    // Between the prompt and the answer: the tool call and its result, no empty reply.
    const from = lines.findIndex((l) => l.includes("List the functions in inventory.py."));
    const to = lines.findIndex((l) => l.includes("total_value sums the stock."));
    expect(lines.slice(from + 1, to).filter((l) => l.trim() === "")).toEqual([]);
    expect(lines.join("\n")).toContain("Resumed session — 3 messages.");
    expect(lines.join("\n")).toContain("Session from llama3.2:3b — the current model stays m.");
    expect(t.app.controller.getState().kind.type).toBe("chat");
  });

  test("a failed task says why and points to /schedule", async () => {
    const t = await run();
    t.bridge.due = [{ name: "daily", slot: SLOT }];
    await until(() => t.bridge.runs().length === 1, t.settle);
    t.bridge.runs()[0]!.fail(new Error("Ollama is offline — start it, then run the task again"));
    await until(() => t.text().join("\n").includes("Task daily failed: Ollama is offline — start it, then run the task again — /schedule for details."), t.settle);
    expect(t.app.controller.getState().taskRunning).toBeNull();
  });

  test("a task that runs under an open panel: its block is in the transcript and comes back when the panel closes", async () => {
    const t = await run({ answers: { "memory.load": { content: "## Editor\nAlex uses Helix.\n" } } });
    await t.submit("/memory");
    await until(() => t.frame().includes("Alex uses Helix."), t.settle);
    t.bridge.due = [{ name: "daily", slot: SLOT }];
    await until(() => t.bridge.runs().length === 1, t.settle);
    t.bridge.runs()[0]!.emit("text", { text: "Hello from the task.\n" });
    t.bridge.runs()[0]!.finish({ status: "ok", summary: "", session: null });
    await until(() => t.text().join("\n").includes("Task daily finished"), t.settle);
    expect(t.frame()).toContain("Alex uses Helix."); // the panel stays
    t.setup.externalOutput.clear();
    t.setup.mockInput.pressEscape();
    await until(() => t.resets.length > 0, t.settle);
    await sleep(80);
    await t.settle();
    await t.setup.flush();
    const rows = t.setup.externalOutput.take().flatMap((c) => c.rows.map((r) => r.trimEnd())).join("\n");
    expect(rows).toMatch(/task daily[\s\S]*Hello from the task\.[\s\S]*Task daily finished/);
  });

  test("quitting while a task runs cancels it through chat.cancel and waits for its end", async () => {
    const t = await run();
    t.bridge.due = [{ name: "daily", slot: SLOT }];
    await until(() => t.bridge.runs().length === 1, t.settle);
    const r = t.bridge.runs()[0]!;
    t.app.controller.exit();
    expect(t.bridge.controls).toContainEqual({ method: "chat.cancel", params: { request_id: r.id } });
    await sleep(150);
    expect(t.closed).toEqual([]); // still waiting for the engine to record it
    r.finish({ status: "cancelled", summary: "", session: null });
    await t.app.closed;
    expect(t.closed).toHaveLength(1);
    open = undefined;
  });

  test("quitting with no task running still closes at once", async () => {
    const t = await run();
    t.app.controller.exit();
    expect(t.closed).toEqual([null]);
    open = undefined;
  });
});
