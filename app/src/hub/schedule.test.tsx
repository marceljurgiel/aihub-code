// Ported from AIhub-TUI v1.5.0 app/src/schedule.test.tsx.
/** Scheduled tasks in the app: the Schedule window, its form, the task queue
 *  and the missed-run window.
 *  aihub-code: the windows are opened as a panel opens them; "run now" goes to
 *  onRunNow. Not ported here (ChatScreen's and useScheduler's clock): /schedule,
 *  the due-task clock, holding chat messages for a task, failures in the chat,
 *  quitting during a run — panels/scheduler.test.tsx covers them against the
 *  controller. */
import { test, expect, afterEach } from "bun:test";
import { MissedTasksModal } from "./modals/MissedTasksModal.tsx";
import { ScheduleModal } from "./modals/ScheduleModal.tsx";
import { MockBridge, openWindow, type Opened } from "./test-tree.tsx";
import { formatSlot } from "./schedule/format.ts";
import { TaskQueue } from "./schedule/queue.ts";

let setup: Opened["setup"] | undefined;
let runNow: string[] = [];
let pending: ScheduleBridge | undefined;
let size = { width: 110, height: 36 };
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function until(pred: (f: string) => boolean, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 40));
    await setup!.flush();
    const f = setup!.captureCharFrame();
    if (pred(f)) return f;
  }
  throw new Error("frame never matched:\n" + setup!.captureCharFrame());
}
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30));
    await setup!.flush();
  }
};
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const DIGEST = {
  name: "mail-digest", agent: "mail", model: "llama3.2:3b", backend: "ollama", stream_model: "llama3.2:3b",
  when: "daily 08:00", prompt: "Summarize today's unread email for alex.", enabled: true,
  created: "2026-10-01T09:00:00", broken: "", path: "/home/alex/.aihub/schedule/mail-digest.md",
  next_run: "2026-10-08T08:00:00", last_run: "2026-10-07T08:00:05", last_status: "ok",
  last_summary: "Three new emails: the Lisbon trip is confirmed.", last_error: "",
  last_session: { model: "llama3.2:3b", filename: "2026-10-07_08-00-05.json" },
};

class ScheduleBridge extends MockBridge {
  calls: Array<[string, any]> = [];
  tasks: any[] = [{ ...DIGEST }];
  listGate: Promise<void> | null = null;
  saveErrors: string[] = [];
  override async request(method: string, params: any = {}): Promise<any> {
    this.calls.push([method, params]);
    switch (method) {
      case "schedule.list":
        if (this.listGate) await this.listGate;
        return { tasks: this.tasks };
      case "schedule.check":
        return { due: [], missed: [] };
      case "schedule.toggle":
        this.tasks = this.tasks.map((t) => (t.name === params.name ? { ...t, enabled: params.enabled } : t));
        return { task: this.tasks.find((t) => t.name === params.name) };
      case "schedule.delete":
        this.tasks = this.tasks.filter((t) => t.name !== params.name);
        return { ok: true };
      case "schedule.save": {
        const err = this.saveErrors.shift();
        if (err) throw new Error(err);
        const t = { ...DIGEST, ...params.task, last_status: null, last_summary: "", last_session: null };
        this.tasks = [...this.tasks.filter((x) => x.name !== (params.original_name ?? t.name)), t];
        return { task: t };
      }
      case "agents.list":
        return { agents: [
          { name: "coder", description: "Writes code", builtin: true },
          { name: "mail", description: "Reads your mail", builtin: true },
        ] };
      default:
        return super.request(method);
    }
  }
  override stream(method: string, params: any, handlers: any): { id: number; done: Promise<any> } {
    if (method === "schedule.run") {
      this.calls.push([method, params]);
      return { id: 9, done: new Promise(() => {}) };
    }
    return super.stream(method, params, handlers);
  }
}

async function open<B extends ScheduleBridge = ScheduleBridge>(
  bridge: B = new ScheduleBridge() as B,
  _ready?: unknown,
  at = { width: 110, height: 36 },
): Promise<B> {
  pending = bridge;
  size = at;
  return bridge;
}

async function showSchedule() {
  runNow = [];
  const win = await openWindow(
    pending,
    (close) => (
      <ScheduleModal
        onClose={close}
        running={() => null}
        onRunNow={(name) => runNow.push(name)}
        onCancelRun={() => {}}
        onOpenSession={() => {}}
        current={{ model: "llama3.2:3b", backend: "ollama", streamModel: "llama3.2:3b" }}
      />
    ),
    size,
  );
  setup = win.setup;
}

async function openSchedule() {
  await showSchedule();
  return until((f) => f.includes("Schedule") && f.includes("mail-digest"));
}

test("slot times read as today / tomorrow / a date", () => {
  const now = new Date(2026, 9, 7, 10, 0);
  expect(formatSlot("2026-10-07T18:30:00", now)).toBe("today 18:30");
  expect(formatSlot("2026-10-08T08:00:00", now)).toBe("tomorrow 08:00");
  expect(formatSlot("2026-10-12T09:00:00", now)).toBe("Mon 12 Oct 09:00");
  expect(formatSlot("2026-10-06T08:00:00", now)).toBe("Tue 6 Oct 08:00");
});

test("opens Schedule with tasks, the last result and the only-while-open note", async () => {
  await open();
  const f = await openSchedule();
  expect(f).toMatch(/\[✓\] mail-digest\s+daily 08:00/);
  expect(f).toContain("ok ·");
  expect(f).toContain("Three new emails: the Lisbon trip is confirmed.");
  expect(f).toContain("Tasks run only while AIhub is open.");
});

test("an 80-column terminal: the hint bar stays one line, every key in it", async () => {
  await open(undefined, undefined, { width: 80, height: 24 });
  const all = (await openSchedule()).split("\n");
  // The panel's top and bottom rules (no corners in the footer).
  const top = all.findIndex((l, i) => /^─+$/.test(l) && all[i + 1]?.includes("Schedule"));
  const bottom = all.findIndex((l, i) => i > top + 1 && /^─{20,}$/.test(l));
  expect(top).toBeGreaterThanOrEqual(0);
  const bar = all[bottom - 1]!;
  for (const k of ["n", "e", "space", "r", "↵", "d"]) expect(bar).toContain(` ${k} `);
  expect(bar).toMatch(/new.*edit.*on\/off.*run.*delete/);
  expect(all[bottom - 2]).not.toMatch(/ n {2}new/);           // no first half of a wrapped bar
});

test("shows Loading tasks… before the list arrives", async () => {
  const bridge = new ScheduleBridge();
  let release = () => {};
  bridge.listGate = new Promise<void>((r) => (release = r));
  await open(bridge);
  await showSchedule();
  await until((f) => f.includes("Loading tasks…"));
  expect(setup!.captureCharFrame()).not.toContain("No scheduled tasks");
  release();
  await until((f) => f.includes("mail-digest"));
});

test("space toggles, r runs now, d needs a second press", async () => {
  const bridge = await open();
  await openSchedule();
  setup!.mockInput.pressKey(" ");
  await until((f) => f.includes("[ ] mail-digest") && f.includes("(off)"));
  expect(bridge.calls).toContainEqual(["schedule.toggle", { name: "mail-digest", enabled: false }]);
  setup!.mockInput.pressKey("r");
  await until(() => runNow.length > 0);
  expect(runNow).toEqual(["mail-digest"]);
  setup!.mockInput.pressKey("d");
  await until((f) => f.includes("Press d again to delete mail-digest."));
  expect(bridge.calls.some(([m]) => m === "schedule.delete")).toBe(false);
  setup!.mockInput.pressKey("d");
  await until((f) => f.includes("No scheduled tasks yet"));
  expect(bridge.calls).toContainEqual(["schedule.delete", { name: "mail-digest" }]);
});

test("n creates a task with the current model; an engine error keeps the form open", async () => {
  const bridge = await open();
  bridge.saveErrors = ["unknown schedule 'tomorrow' — use one of: every 30m · daily 08:00"];
  await openSchedule();
  setup!.mockInput.pressKey("n");
  await until((f) => f.includes("Task name"));
  await settle();
  await setup!.mockInput.typeText("weekly-report");
  await pause();
  setup!.mockInput.pressEnter();
  await until((f) => f.includes("Which agent runs it?") && f.includes("model: llama3.2:3b (current)"));
  setup!.mockInput.pressArrow("down");                                   // coder → mail
  await settle();
  setup!.mockInput.pressEnter();
  await until((f) => f.includes("When?") && f.includes("weekdays 08:00"));
  await settle();
  await setup!.mockInput.typeText("tomorrow");
  await pause();
  setup!.mockInput.pressEnter();
  await until((f) => f.includes("What should mail do?"));
  await settle();
  await setup!.mockInput.typeText("Summarize the week for alex.");
  setup!.mockInput.pressKey("s", { ctrl: true });
  await until((f) => f.includes("unknown schedule 'tomorrow'"));
  expect(setup!.captureCharFrame()).toContain("What should mail do?");   // still in the form
  setup!.mockInput.pressKey("s", { ctrl: true });                        // second save succeeds
  await until((f) => f.includes("weekly-report") && f.includes("Tasks run only while AIhub is open."));
  const saves = bridge.calls.filter(([m]) => m === "schedule.save").map(([, p]) => p);
  expect(saves[1].task).toMatchObject({
    name: "weekly-report", agent: "mail", when: "tomorrow", prompt: "Summarize the week for alex.",
    model: "llama3.2:3b", backend: "ollama", stream_model: "llama3.2:3b", enabled: true,
  });
});

test("e edits the selected task and keeps its name as original_name", async () => {
  const bridge = await open();
  await openSchedule();
  setup!.mockInput.pressKey("e");
  await until((f) => f.includes("Task name"));
  await pause();
  setup!.mockInput.pressEnter();                                         // keep the name
  await until((f) => f.includes("Which agent runs it?") && f.includes("model: llama3.2:3b"));
  setup!.mockInput.pressEnter();                                         // keep mail
  await until((f) => f.includes("When?"));
  await pause();
  setup!.mockInput.pressEnter();                                         // keep daily 08:00
  await until((f) => f.includes("What should mail do?"));
  await settle();
  setup!.mockInput.pressKey("s", { ctrl: true });
  await until((f) => f.includes("Tasks run only while AIhub is open."));
  const save = bridge.calls.find(([m]) => m === "schedule.save")![1];
  expect(save.original_name).toBe("mail-digest");
  expect(save.task).toMatchObject({ name: "mail-digest", agent: "mail", when: "daily 08:00",
                                    prompt: "Summarize today's unread email for alex." });
});



// ── The clock, the queue and the missed-run prompt ───────────────────────────

test("TaskQueue: one at a time, no duplicates, never next to a chat turn", () => {
  const q = new TaskQueue();
  expect(q.enqueue("a", "s1")).toBe(true);
  expect(q.enqueue("a", "s2")).toBe(false);                 // already waiting
  expect(q.enqueue("b")).toBe(true);
  expect(q.next(true)).toBeNull();                           // chat is busy
  expect(q.next(false)).toEqual({ name: "a", slot: "s1" });
  q.start("a");
  expect(q.running).toBe("a");
  expect(q.enqueue("a")).toBe(false);                        // running
  expect(q.next(false)).toBeNull();                          // one at a time
  q.finish();
  expect(q.next(false)).toEqual({ name: "b", slot: undefined });
  expect(q.size).toBe(0);
});

test("the missed-run window: Enter runs, s skips", async () => {
  const choices: string[] = [];
  const task = { name: "mail-digest", when: "daily 08:00", slot: "2026-10-07T08:00:00" };
  const win = await openWindow(new MockBridge(), (close) => (
    <MissedTasksModal task={task} index={0} total={2} onClose={(c) => { choices.push(c); close(); }} />
  ));
  setup = win.setup;
  await until((f) => f.includes("Missed while AIhub was closed") && f.includes("mail-digest") && f.includes("daily 08:00"));
  await pause();
  setup.mockInput.pressEnter();
  await until(() => choices.length === 1);
  win.reopen();
  await until((f) => f.includes("mail-digest"));
  await pause();
  setup.mockInput.pressKey("s");
  await until(() => choices.length === 2);
  expect(choices).toEqual(["run", "skip"]);
});
