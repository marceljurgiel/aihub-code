import { describe, expect, test } from "bun:test";
import type { Args } from "./args";
import { COMMANDS, SLASH_COMMANDS, commandTable } from "./commands";
import { G } from "./glyphs";
import { memorySink } from "./scrollback";
import { Controller } from "./session/controller";
import { MockBridge } from "./session/mock-bridge";
import { fmtCompaction, fmtTodos } from "./transcript/format";
import { lineText } from "./width";

const INFO = {
  session_id: "s1",
  project: { root: "/home/alex/proj", branch: "main", dirty_total: 0, instruction_file: null, is_git: true },
  mode: "build",
  model: "gemma4:cloud",
  rules: [],
  context_length: 8192,
  checkpoints: { mode: "shadow", note: "" },
};
const ARGS: Args = { cont: false, mcp: [], kb: [] };
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function make(width = 80) {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud" };
  bridge.answers["code.start"] = (p: Record<string, unknown>) => ({ ...INFO, model: p.model, mode: p.mode, session_id: `s-${p.model}` });
  bridge.answers["code.mode"] = (p: Record<string, unknown>) => ({ mode: p.mode });
  bridge.answers["models.installed"] = { models: [{ name: "gemma4:cloud" }, { name: "llama3.2:3b" }] };
  const sink = memorySink();
  const exits: string[] = [];
  const resumed: unknown[][] = [];
  const c = new Controller({
    bridge,
    sink,
    now: () => 1000,
    width: () => width,
    cwd: "/home/alex/proj",
    home: "/home/alex",
    commands: commandTable(),
    onExit: () => exits.push("exit"),
    onResume: (m) => resumed.push(m),
  });
  return { bridge, sink, c, exits, resumed };
}

async function started(width = 80) {
  const m = make(width);
  await m.c.start(ARGS);
  const mark = m.sink.lines.length;
  /** Run one input line and return what it wrote. */
  const run = async (text: string) => {
    const before = m.sink.lines.length;
    m.c.submit(text);
    await settle();
    // Every slash command is echoed first (see "the echo"): its output follows.
    return m.sink.lines.slice(before + (text.trimStart().startsWith("/") && !text.trimStart().startsWith("//") ? 1 : 0));
  };
  return { ...m, mark, run };
}

/** A running turn. */
async function running() {
  const m = await started();
  m.c.submit("fix it");
  await settle();
  return { ...m, turn: m.bridge.lastStream };
}

const WAIT = "wait for the current turn to finish";

describe("routing", () => {
  test("slash input goes to the command table, not to the model", async () => {
    const m = await started();
    expect(await m.run("/nope")).toEqual(["unknown command /nope — /help lists them"]);
    expect(m.bridge.streams).toEqual([]);
    expect(m.c.getState().queue).toEqual([]);
  });

  test("the command name is not case sensitive", async () => {
    const m = await started();
    await m.run("/CONTEXT");
    expect(m.sink.lines.at(-1)).toContain("context:");
  });

  test("// sends a literal prompt that starts with a slash", async () => {
    const m = await started();
    m.c.submit("//etc/hosts is odd");
    await settle();
    expect(m.bridge.streams[0]!.method).toBe("code.turn");
    expect(m.bridge.streams[0]!.params).toEqual({ text: "/etc/hosts is odd" });
  });

  test("a path typed as the first word says how to send it as text", async () => {
    const m = await started();
    const out = await m.run("/home/alex/x.py is broken");
    expect(out[0]).toContain("unknown command /home/alex/x.py");
    expect(out.join("\n")).toContain("//");
    expect(m.bridge.streams).toEqual([]);
  });

  test("a command runs at once, also while a turn runs: it is never queued", async () => {
    const m = await running();
    const out = await m.run("/context");
    expect(out[0]).toContain("context:");
    expect(m.c.getState().queue).toEqual([]);
  });

  test("a command's argument keeps its inner spaces and loses the outer ones", async () => {
    const m = await started();
    m.bridge.answers["code.rules.list"] = { rules: [] };
    await m.run("  /rules   remove   1  ");
    expect(m.sink.lines.join("\n")).toContain("no rule 1");
  });

  test("a failing command prints its error and the app goes on", async () => {
    const m = await started();
    m.bridge.answers["code.todos"] = new Error("the engine fell over");
    const out = await m.run("/todos");
    expect(out).toEqual([`${G.cross} the engine fell over`]);
    expect(m.c.getState().phase).toBe("idle");
  });

  test("the table: names from the spec, each with help, hints for the footer", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "help", "mode", "plan", "model", "undo", "compact", "todos", "rules", "sessions", "resume", "clear", "new", "context",
      "models", "hardware", "agents", "skills", "mcp", "knowledge", "schedule", "history", "memory", "settings", "theme", "temp",
      "exit",
    ]);
    for (const c of COMMANDS) expect(c.help.length).toBeGreaterThan(5);
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(Object.keys(commandTable())).toEqual(COMMANDS.map((c) => c.name));
  });
});

describe("/memory", () => {
  test("opens AIhub's memory window as a panel", async () => {
    const m = await started();
    expect(await m.run("/memory")).toEqual([]);
    expect(m.c.getState().panel).toEqual({ id: "memory" });
  });
});

describe("AIhub's windows", () => {
  const PANELS: Array<[string, string]> = [
    ["/models", "models"],
    ["/hardware", "hardware"],
    ["/agents", "agents"],
    ["/skills", "skills"],
    ["/mcp", "mcp"],
    ["/knowledge", "knowledge"],
    ["/schedule", "schedule"],
    ["/history", "history"],
    ["/settings", "settings"],
    ["/theme", "theme"],
    ["/temp", "temperature"],
    ["/help", "help"],
    ["/memory", "memory"],
  ];
  for (const [cmd, id] of PANELS) {
    test(`${cmd} with no argument opens the ${id} panel`, async () => {
      const m = await started();
      expect(await m.run(cmd)).toEqual([]);
      expect(m.c.getState().panel).toEqual({ id: id as never });
    });
  }

  test("a text form a later task brings says so and opens nothing", async () => {
    const m = await started();
    for (const cmd of ["/temp 0.3", "/theme nord", "/schedule run daily", "/memory undo"]) {
      const out = await m.run(cmd);
      expect(out.join(" ")).toBe(`${cmd} — coming in this release`);
      expect(m.c.getState().panel).toBeNull();
    }
  });

  test("while a turn runs a window is refused with the note", async () => {
    const m = await running();
    await m.run("/settings");
    expect(m.c.getState().panel).toBeNull();
    expect(m.sink.lines.join("\n")).toContain("Finish or interrupt the current turn first (Esc).");
  });

  test("/new is /clear", async () => {
    const m = await started();
    await m.run("/new");
    expect(m.bridge.to("code.start")).toHaveLength(2);
  });

  test("/hub is gone", async () => {
    const m = await started();
    const out = (await m.run("/hub")).join(" ");
    expect(out).toContain("unknown command /hub");
  });
});

describe("the echo", () => {
  test("a command is echoed as a dim user line, before its output", async () => {
    const m = await started();
    m.c.submit("/context");
    await settle();
    const i = m.sink.lines.length - 2;
    expect(m.sink.lines[i]).toBe("> /context");
    expect(m.sink.lines[i + 1]).toContain("context:");
    expect(m.sink.styled[i]!.every((sp) => sp.dim)).toBe(true);
  });

  test("with its argument, trimmed, on one line; unknown commands too", async () => {
    const m = await started();
    m.c.submit("  /mode   plan  ");
    await settle();
    expect(m.sink.lines.at(-2)).toBe("> /mode plan");
    m.c.submit("/nope a\nb");
    await settle();
    expect(m.sink.lines.at(-2)).toBe("> /nope a b");
  });

  test("escape codes in the typed text are cleaned", async () => {
    const m = await started();
    m.c.submit("/x\u001b[2Jy");
    await settle();
    expect(m.sink.lines.join("\n")).not.toContain("\u001b");
  });

  test("a // prompt is a user prompt, not an echo", async () => {
    const m = await started();
    m.c.submit("//hi");
    await settle();
    expect(m.sink.lines.at(-1)).toBe("> /hi");
    expect(m.sink.styled.at(-1)![0]!.dim).toBeFalsy();
  });
});

describe("/help", () => {
  test("with an argument: lists every command with its arguments and help, then the keys", async () => {
    const m = await started();
    const out = (await m.run("/help keys")).join("\n").replace(/\s+/g, " ");
    for (const c of COMMANDS) {
      expect(out).toContain(`/${c.name}`);
      expect(out).toContain(c.help);
    }
    expect(out).toContain("/mode [plan|build|auto]");
    expect(out).toContain("/rules [remove N]");
    expect(out).toContain("shift+tab");
    expect(out).toContain("Shift+Enter needs a terminal with the kitty keyboard protocol; Ctrl+J always adds a line");
    expect(out).toContain("To send text that begins with /, start it with //.");
  });

  test("on a narrow terminal nothing is wider than the screen", async () => {
    const m = await started(30);
    for (const l of await m.run("/help keys")) expect(lineText([{ text: l }]).length).toBeLessThanOrEqual(30);
  });

  test("works before any session exists", async () => {
    const m = make();
    m.c.submit("/help keys");
    await settle();
    expect(m.sink.lines.join("\n")).toContain("/undo");
  });
});

describe("/mode and /plan", () => {
  test("/mode plan asks the engine and says so", async () => {
    const m = await started();
    await m.run("/mode plan");
    expect(m.bridge.to("code.mode")).toEqual([{ method: "code.mode", params: { mode: "plan" } }]);
    expect(m.sink.lines.at(-1)).toBe("mode: plan");
    expect(m.c.getState().mode).toBe("plan");
  });

  test("/plan is /mode plan", async () => {
    const m = await started();
    await m.run("/plan");
    expect(m.bridge.to("code.mode")[0]!.params).toEqual({ mode: "plan" });
  });

  test("/mode without an argument shows the mode and the choices", async () => {
    const m = await started();
    expect(await m.run("/mode")).toEqual(["mode: build (change it with /mode plan, /mode build or /mode auto)"]);
    expect(m.bridge.to("code.mode")).toEqual([]);
  });

  test("an unknown mode and the mode already set are said, not sent", async () => {
    const m = await started();
    expect(await m.run("/mode fast")).toEqual(["unknown mode fast — use plan, build or auto"]);
    expect(await m.run("/mode build")).toEqual(["already in build mode"]);
    expect(m.bridge.to("code.mode")).toEqual([]);
  });

  test("while a turn runs the mode waits", async () => {
    const m = await running();
    const out = await m.run("/mode plan");
    expect(out).toEqual(["mode can change when the turn is done"]);
    expect(m.bridge.to("code.mode")).toEqual([]);
  });

  test("without a session it says so", async () => {
    const m = make();
    m.c.submit("/mode plan");
    await settle();
    expect(m.sink.lines.at(-1)).toBe("no session yet");
  });
});

describe("/context", () => {
  test("used and limit, as a percentage and in tokens", async () => {
    const m = await started();
    m.c.submit("go");
    await settle();
    m.bridge.lastStream.emit("code_context", { used: 4096, limit: 8192 });
    m.bridge.lastStream.finish({});
    await settle();
    expect(await m.run("/context")).toEqual(["context: 50% used (4.1k of 8.2k tokens)"]);
  });

  test("an unknown limit is said", async () => {
    const m = await started();
    m.bridge.answers["code.start"] = { ...INFO, context_length: 0 };
    m.c.submit("/clear");
    await settle();
    expect(await m.run("/context")).toEqual(["context: size not known yet"]);
  });
});

describe("/todos", () => {
  test("prints the list through the transcript formatter and keeps it in the state", async () => {
    const m = await started();
    const todos = [
      { content: "write the test", status: "completed" },
      { content: "fix calc", status: "in_progress" },
    ];
    m.bridge.answers["code.todos"] = { todos };
    const out = await m.run("/todos");
    expect(out).toEqual(fmtTodos(todos as never, 80).map(lineText));
    expect(m.c.getState().todos).toEqual(todos as never);
  });

  test("an empty list says so", async () => {
    const m = await started();
    m.bridge.answers["code.todos"] = { todos: [] };
    expect((await m.run("/todos")).join("")).toContain("no todos");
  });
});

describe("/rules", () => {
  const RULES = [
    { tool: "edit_file", pattern: null, scope: "session" },
    { tool: "run_terminal", pattern: "git status", scope: "project" },
  ];

  test("lists the rules, numbered", async () => {
    const m = await started();
    m.bridge.answers["code.rules.list"] = { rules: RULES };
    expect(await m.run("/rules")).toEqual([
      "rules:",
      "  1. edit_file (session)",
      "  2. run_terminal: git status (project)",
      "/rules remove N removes one",
    ]);
  });

  test("no rules: how to get one", async () => {
    const m = await started();
    m.bridge.answers["code.rules.list"] = { rules: [] };
    expect(await m.run("/rules")).toEqual(["no rules yet — \"don't ask again\" in a permission prompt adds one"]);
  });

  test("remove N sends that rule as the engine listed it", async () => {
    const m = await started();
    m.bridge.answers["code.rules.list"] = { rules: RULES };
    m.bridge.answers["code.rules.remove"] = { rules: [RULES[0]] };
    expect(await m.run("/rules remove 2")).toEqual(["removed rule 2: run_terminal: git status"]);
    expect(m.bridge.to("code.rules.remove")[0]!.params).toEqual({ tool: "run_terminal", pattern: "git status", scope: "project" });
  });

  test("a number that is not there, and a word that is not a number", async () => {
    const m = await started();
    m.bridge.answers["code.rules.list"] = { rules: RULES };
    expect(await m.run("/rules remove 9")).toEqual(["no rule 9 — /rules lists them"]);
    expect(await m.run("/rules remove x")).toEqual(["usage: /rules remove N"]);
    expect(await m.run("/rules zap")).toEqual(["usage: /rules, or /rules remove N"]);
    expect(m.bridge.to("code.rules.remove")).toEqual([]);
  });

  test("rule text from the engine carries no escape codes", async () => {
    const m = await started();
    m.bridge.answers["code.rules.list"] = { rules: [{ tool: "run_terminal", pattern: "x\u001b[2Jy", scope: "project" }] };
    expect((await m.run("/rules")).join("\n")).not.toContain("\u001b");
  });
});

describe("/compact", () => {
  test("streams code.compact, shows the result line and the activity, then goes idle", async () => {
    const m = await started();
    m.c.submit("/compact");
    await settle();
    const s = m.bridge.lastStream;
    expect(s.method).toBe("code.compact");
    expect(m.c.getState().phase).toBe("running");
    expect(m.c.getState().activity?.label).toBe("compacting…");
    const ev = { method: "summary", before: 6000, after: 1500 };
    s.emit("code_compaction", ev);
    s.finish({ result: ev });
    await settle();
    expect(m.sink.lines.at(-1)).toBe(lineText(fmtCompaction(ev, 8192)[0]!));
    expect(m.c.getState()).toMatchObject({ phase: "idle", activity: null });
    expect(m.c.getState().ctx.used).toBe(1500);
  });

  test("a prompt typed meanwhile waits for the end of the compaction", async () => {
    const m = await started();
    m.c.submit("/compact");
    await settle();
    m.c.submit("and then?");
    expect(m.c.getState().queue).toEqual(["and then?"]);
    m.bridge.lastStream.finish({});
    await settle();
    expect(m.bridge.lastStream.method).toBe("code.turn");
  });

  test("Esc cancels it like a turn", async () => {
    const m = await started();
    m.c.submit("/compact");
    await settle();
    m.c.cancel();
    expect(m.bridge.controls).toEqual([{ method: "chat.cancel", params: { request_id: m.bridge.lastStream.id } }]);
    m.bridge.lastStream.finish({});
    await settle();
    expect(m.c.getState().phase).toBe("idle");
  });

  test("a failure is printed and the input is usable again", async () => {
    const m = await started();
    m.c.submit("/compact");
    await settle();
    m.bridge.lastStream.fail(new Error("the model is not answering"));
    await settle();
    expect(m.sink.lines.at(-1)).toBe(`${G.cross} the model is not answering`);
    expect(m.c.getState().phase).toBe("idle");
  });

  test("not while a turn runs", async () => {
    const m = await running();
    expect(await m.run("/compact")).toEqual([WAIT]);
    expect(m.bridge.streams).toHaveLength(1);
  });
});

describe("/undo", () => {
  const PLAN = { turn_id: "t1", restore: ["calc.py"], delete: ["new.txt"], conflicts: [], shell_not_reverted: [], skipped: [], mode: "shadow", applied: false };

  test("shows the files and asks in the footer; nothing is undone yet", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = PLAN;
    const out = await m.run("/undo");
    expect(out).toEqual(["the last turn changed 2 files:", "  restore  calc.py", "  delete   new.txt"]);
    expect(m.bridge.to("code.undo")).toEqual([{ method: "code.undo", params: {} }]);
    expect(m.c.getState().confirm).toEqual({ question: "Undo these changes? (y/N)", detail: "restore 1 file, delete 1 file", force: false });
  });

  test("y undoes it: code.undo confirm, and says what happened", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = (p: Record<string, unknown>) => ({ ...PLAN, applied: p.confirm === true });
    await m.run("/undo");
    const before = m.sink.lines.length;
    await m.c.answerConfirm(true);
    expect(m.bridge.to("code.undo").at(-1)!.params).toEqual({ confirm: true });
    expect(m.sink.lines.slice(before)).toEqual(["undone: restored 1 file, deleted 1 file"]);
    expect(m.c.getState().confirm).toBeNull();
  });

  test("n leaves everything as it is", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = PLAN;
    await m.run("/undo");
    const before = m.sink.lines.length;
    await m.c.answerConfirm(false);
    expect(m.bridge.to("code.undo")).toHaveLength(1);
    expect(m.sink.lines.slice(before)).toEqual(["nothing was undone"]);
    expect(m.c.getState().confirm).toBeNull();
  });

  test("conflicts: the files are listed, no question, /undo force is the way", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = { ...PLAN, conflicts: ["calc.py"] };
    const out = await m.run("/undo");
    expect(out).toEqual([
      "the last turn changed 2 files:",
      "  restore  calc.py",
      "  delete   new.txt",
      "these changed after the turn: calc.py",
      "/undo force undoes them anyway (your newer changes are lost)",
    ]);
    expect(m.c.getState().confirm).toBeNull();
  });

  test("/undo force asks too, and y sends confirm and force", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = (p: Record<string, unknown>) => ({ ...PLAN, conflicts: ["calc.py"], applied: p.confirm === true && p.force === true });
    await m.run("/undo force");
    expect(m.c.getState().confirm).toMatchObject({ force: true });
    await m.c.answerConfirm(true);
    expect(m.bridge.to("code.undo").at(-1)!.params).toEqual({ confirm: true, force: true });
    expect(m.sink.lines.at(-1)).toBe("undone: restored 1 file, deleted 1 file");
  });

  test("a conflict that shows up only when confirming is listed, nothing is undone", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = (p: Record<string, unknown>) => (p.confirm ? { ...PLAN, conflicts: ["new.txt"] } : PLAN);
    await m.run("/undo");
    const before = m.sink.lines.length;
    await m.c.answerConfirm(true);
    expect(m.sink.lines.slice(before)).toEqual([
      "these changed after the turn: new.txt",
      "/undo force undoes them anyway (your newer changes are lost)",
    ]);
    expect(m.c.getState().confirm).toBeNull();
  });

  test("shell commands and skipped files are mentioned", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = { ...PLAN, shell_not_reverted: ["pip install requests"], skipped: ["big.bin"] };
    const out = await m.run("/undo");
    expect(out).toContain("shell commands are not undone: pip install requests");
    expect(out).toContain("can't be put back safely: big.bin");
  });

  test("a turn without file changes still asks", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = { ...PLAN, restore: [], delete: [] };
    const out = await m.run("/undo");
    expect(out).toEqual(["the last turn changed no files"]);
    expect(m.c.getState().confirm).toMatchObject({ detail: "no file changes" });
  });

  test("a long list is cut", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = { ...PLAN, restore: Array.from({ length: 30 }, (_, i) => `f${i}.py`), delete: [] };
    const out = await m.run("/undo");
    expect(out.length).toBeLessThan(20);
    expect(out.join("\n")).toContain("… 18 more");
  });

  test("nothing to undo is a note, not an error", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = new Error("nothing to undo");
    expect(await m.run("/undo")).toEqual(["nothing to undo"]);
    expect(m.c.getState().confirm).toBeNull();
  });

  test("another engine error is printed", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = new Error("that turn belongs to another session");
    expect(await m.run("/undo")).toEqual([`${G.cross} that turn belongs to another session`]);
  });

  test("not while a turn runs, and no call goes out", async () => {
    const m = await running();
    expect(await m.run("/undo")).toEqual([WAIT]);
    expect(m.bridge.to("code.undo")).toEqual([]);
  });

  test("file names with escape codes are cleaned", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = { ...PLAN, restore: ["a\u001b[2Jb.py"], delete: [] };
    expect((await m.run("/undo")).join("\n")).not.toContain("\u001b");
  });

  test("a prompt typed while the question is open waits for the answer", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = PLAN;
    await m.run("/undo");
    m.c.submit("hello");
    await settle();
    expect(m.bridge.streams).toEqual([]);
    expect(m.c.getState().queue).toEqual(["hello"]);
    m.bridge.answers["code.undo"] = { ...PLAN, applied: true };
    await m.c.answerConfirm(false);
    await settle();
    expect(m.bridge.streams[0]!.method).toBe("code.turn");
  });
});

describe("/sessions and /resume", () => {
  const SESSIONS = {
    sessions: [
      { id: "a", title: "fix calc", turns: 3, updated: "2026-10-26T10:00:00" },
      { id: "b", title: "docs", turns: 1, updated: "2026-10-25T09:00:00" },
    ],
  };

  test("/sessions opens the picker with the project's sessions", async () => {
    const m = await started();
    m.bridge.answers["code.sessions"] = SESSIONS;
    await m.run("/sessions");
    expect(m.bridge.to("code.sessions")[0]!.params).toEqual({ cwd: "/home/alex/proj" });
    const st = m.c.getState();
    expect(st.phase).toBe("picker");
    expect(st.picker!.kind).toBe("session");
    expect(st.picker!.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  test("choosing one resumes it: code.resume, the saved conversation is replayed", async () => {
    const m = await started();
    m.bridge.answers["code.sessions"] = SESSIONS;
    m.bridge.answers["code.resume"] = { ...INFO, session_id: "b", model: "saved:7b", messages: [{ role: "user", content: "hi" }] };
    await m.run("/resume");
    await m.c.pick("b");
    expect(m.bridge.to("code.resume")[0]!.params).toEqual({ cwd: "/home/alex/proj", session_id: "b" });
    expect(m.c.getState()).toMatchObject({ phase: "idle", sessionId: "b", model: "saved:7b", picker: null });
    expect(m.resumed).toEqual([[{ role: "user", content: "hi" }]]);
  });

  test("Esc closes the picker and leaves the session alone", async () => {
    const m = await started();
    m.bridge.answers["code.sessions"] = SESSIONS;
    await m.run("/sessions");
    await m.c.pick(null);
    expect(m.c.getState()).toMatchObject({ phase: "idle", picker: null, sessionId: "s-gemma4:cloud" });
    expect(m.bridge.to("code.resume")).toEqual([]);
    expect(m.bridge.to("code.start")).toHaveLength(1);
    expect(m.exits).toEqual([]);
  });

  test("/resume <id> goes straight there", async () => {
    const m = await started();
    m.bridge.answers["code.resume"] = { ...INFO, session_id: "a", messages: [] };
    await m.run("/resume a");
    expect(m.bridge.to("code.resume")[0]!.params).toEqual({ cwd: "/home/alex/proj", session_id: "a" });
    expect(m.c.getState().sessionId).toBe("a");
  });

  test("a resume that fails keeps the old session and says why", async () => {
    const m = await started();
    m.bridge.answers["code.resume"] = new Error("no such session: zz");
    const out = await m.run("/resume zz");
    expect(out).toEqual([`${G.cross} no such session: zz`]);
    expect(m.c.getState()).toMatchObject({ phase: "idle", sessionId: "s-gemma4:cloud" });
  });

  test("no sessions here is a note", async () => {
    const m = await started();
    m.bridge.answers["code.sessions"] = { sessions: [] };
    expect(await m.run("/sessions")).toEqual(["no earlier session in this folder"]);
    expect(m.c.getState().phase).toBe("idle");
  });

  test("not while a turn runs", async () => {
    const m = await running();
    expect(await m.run("/sessions")).toEqual([WAIT]);
    expect(await m.run("/resume a")).toEqual([WAIT]);
    expect(m.bridge.to("code.sessions")).toEqual([]);
  });
});

describe("/model", () => {
  const CLOUD = {
    models: [
      { name: "gemma4:cloud", status: "free", installed: true },
      { name: "gpt-oss:120b-cloud", status: "free", installed: false },
      { name: "old-thing:cloud", status: "retired", installed: false },
    ],
  };

  test("the picker lists installed models, then the cloud ones not yet installed (not the retired)", async () => {
    const m = await started();
    m.bridge.answers["cloud.models"] = CLOUD;
    await m.run("/model");
    const st = m.c.getState();
    expect(st.phase).toBe("picker");
    expect(st.picker!.kind).toBe("model");
    expect(st.picker!.items.map((i) => i.id)).toEqual(["gemma4:cloud", "llama3.2:3b", "gpt-oss:120b-cloud"]);
    expect(st.picker!.items[2]!.label).toContain("cloud");
  });

  test('"loading models…" shows while the lists come in', async () => {
    const m = await started();
    let release!: (v: unknown) => void;
    // The mock answers at once; hold this one back to see the state in between.
    const orig = m.bridge.request.bind(m.bridge);
    m.bridge.request = ((method: string, params: Record<string, unknown> = {}) =>
      method === "cloud.models" ? new Promise<unknown>((r) => (release = r)) : orig(method, params)) as typeof m.bridge.request;
    m.c.submit("/model");
    await settle();
    expect(m.c.getState().activity?.label).toBe("loading models…");
    expect(m.c.getState().phase).toBe("idle");
    release(CLOUD);
    await settle();
    expect(m.c.getState().activity).toBeNull();
    expect(m.c.getState().phase).toBe("picker");
  });

  test("when the cloud list fails, the installed models are listed and it is said", async () => {
    const m = await started();
    m.bridge.answers["cloud.models"] = new Error("ollama.com did not answer");
    const out = await m.run("/model");
    expect(m.c.getState().picker!.items.map((i) => i.id)).toEqual(["gemma4:cloud", "llama3.2:3b"]);
    expect(out).toEqual(["could not load the cloud list — showing installed models"]);
  });

  test("choosing a model starts a new session with the same mode; the old one stays resumable", async () => {
    const m = await started();
    m.bridge.answers["cloud.models"] = CLOUD;
    await m.run("/mode plan");
    await m.run("/model");
    const before = m.sink.lines.length;
    await m.c.pick("llama3.2:3b");
    expect(m.bridge.to("code.start").at(-1)!.params).toMatchObject({ model: "llama3.2:3b", mode: "plan", cwd: "/home/alex/proj" });
    expect(m.sink.lines.slice(before).join("\n")).toContain("new session with llama3.2:3b");
    expect(m.c.getState()).toMatchObject({ phase: "idle", model: "llama3.2:3b", sessionId: "s-llama3.2:3b", mode: "plan" });
  });

  test("/model <name> switches without a picker", async () => {
    const m = await started();
    await m.run("/model llama3.2:3b");
    expect(m.bridge.to("code.start").at(-1)!.params).toMatchObject({ model: "llama3.2:3b" });
    expect(m.c.getState().model).toBe("llama3.2:3b");
  });

  test("/model <name> that the server lacks opens the picker with a note", async () => {
    const m = await started();
    const out = await m.run("/model nope:1b");
    expect(out.join("\n")).toContain("nope:1b isn't available");
    expect(m.c.getState().phase).toBe("picker");
    expect(m.bridge.to("code.start")).toHaveLength(1);
  });

  test("Esc closes the picker and keeps the session", async () => {
    const m = await started();
    m.bridge.answers["cloud.models"] = CLOUD;
    await m.run("/model");
    await m.c.pick(null);
    expect(m.c.getState()).toMatchObject({ phase: "idle", picker: null, model: "gemma4:cloud" });
    expect(m.exits).toEqual([]);
  });

  test("a start that fails keeps the old session usable", async () => {
    const m = await started();
    m.bridge.answers["code.start"] = (p: Record<string, unknown>) => (p.model === "llama3.2:3b" ? new Error("could not load llama3.2:3b") : { ...INFO, session_id: "s2", model: p.model });
    const out = await m.run("/model llama3.2:3b");
    expect(out).toContain(`${G.cross} could not load llama3.2:3b`);
    expect(m.c.getState()).toMatchObject({ phase: "idle", sessionId: "s-gemma4:cloud", model: "gemma4:cloud" });
  });

  test("not while a turn runs", async () => {
    const m = await running();
    expect(await m.run("/model")).toEqual([WAIT]);
    expect(m.bridge.to("models.installed")).toHaveLength(0);
  });
});

describe("after a failed start (the prompt stays usable for /model and /sessions)", () => {
  async function failed() {
    const m = make();
    m.bridge.answers["code.start"] = (p: Record<string, unknown>) =>
      p.model === "gemma4:cloud" ? new Error("knowledge base nosuch not found") : { ...INFO, session_id: `s-${p.model}`, model: p.model };
    m.bridge.answers["cloud.models"] = { models: [] };
    await m.c.start({ ...ARGS, kb: ["nosuch"] });
    expect(m.c.getState().phase).toBe("error");
    const run = async (text: string) => {
      const before = m.sink.lines.length;
      m.c.submit(text);
      await settle();
      return m.sink.lines.slice(before + 1);
    };
    return { ...m, run };
  }

  test("/model opens the picker; a choice starts a session", async () => {
    const m = await failed();
    const out = await m.run("/model");
    expect(out.join("\n")).not.toContain("try again");
    expect(m.c.getState().picker?.kind).toBe("model");
    await m.c.pick("llama3.2:3b");
    expect(m.c.getState()).toMatchObject({ phase: "idle", sessionId: "s-llama3.2:3b", error: null });
  });

  test("Esc in that picker goes back to where it was: no exit, the error stays", async () => {
    const m = await failed();
    await m.run("/model");
    expect(m.c.getState().picker).not.toBeNull();
    await m.c.pick(null);
    expect(m.c.getState()).toMatchObject({ phase: "error", picker: null });
    expect(m.exits).toEqual([]);
  });

  test("/sessions opens its picker too", async () => {
    const m = await failed();
    m.bridge.answers["code.sessions"] = { sessions: [{ id: "old", updated: "", title: "t", turns: 1 }] };
    m.bridge.answers["code.resume"] = { ...INFO, session_id: "old" };
    await m.run("/sessions");
    expect(m.c.getState().picker?.kind).toBe("session");
    await m.c.pick("old");
    expect(m.c.getState()).toMatchObject({ phase: "idle", sessionId: "old" });
  });
});

describe("/clear", () => {
  test("a new session with the same model and mode, and a dim divider in the transcript", async () => {
    const m = await started();
    await m.run("/mode auto");
    m.bridge.answers["code.start"] = (p: Record<string, unknown>) => ({ ...INFO, model: p.model, mode: p.mode, session_id: "s2" });
    const out = await m.run("/clear");
    expect(m.bridge.to("code.start").at(-1)!.params).toEqual({ cwd: "/home/alex/proj", model: "gemma4:cloud", mode: "auto", mcp: [], knowledge: [] });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("new session");
    expect(out[0]!.startsWith(G.h)).toBe(true);
    expect(out[0]!.length).toBeLessThanOrEqual(80);
    expect(m.c.getState()).toMatchObject({ phase: "idle", sessionId: "s2", model: "gemma4:cloud", mode: "auto", ctx: { used: 0, limit: 8192 }, todos: [] });
    const span = m.sink.styled.at(-1)!;
    expect(span.every((s) => s.dim)).toBe(true);
  });

  test("keeps the MCP and knowledge choices of this run", async () => {
    const m = make();
    await m.c.start({ cont: false, mcp: ["files"], kb: ["docs"] });
    m.c.submit("/clear");
    await settle();
    expect(m.bridge.to("code.start").at(-1)!.params).toMatchObject({ mcp: ["files"], knowledge: ["docs"] });
  });

  test("prompts typed meanwhile wait for the new session", async () => {
    const m = await started();
    m.c.submit("/clear");
    m.c.submit("first prompt");
    await settle();
    expect(m.bridge.lastStream.method).toBe("code.turn");
    expect(m.bridge.calls.map((c) => c.method).slice(-2)).toEqual(["code.start", "code.turn"]);
  });

  test("a failed start keeps the old session", async () => {
    const m = await started();
    m.bridge.answers["code.start"] = new Error("Another aihub-code session is working in this project.");
    const out = await m.run("/clear");
    expect(out).toEqual([`${G.cross} Another aihub-code session is working in this project.`]);
    expect(m.c.getState()).toMatchObject({ phase: "idle", sessionId: "s-gemma4:cloud" });
  });

  test("not while a turn runs", async () => {
    const m = await running();
    expect(await m.run("/clear")).toEqual([WAIT]);
  });

  test("the exit hint follows the new session: nothing said until it has a turn", async () => {
    const m = await started();
    m.c.submit("one");
    await settle();
    m.bridge.lastStream.finish({});
    await settle();
    m.bridge.answers["code.start"] = { ...INFO, session_id: "s2" };
    await m.run("/clear");
    m.c.exit();
    expect(m.sink.lines.join("\n")).not.toContain("--resume");
  });
});

describe("/exit", () => {
  test("/exit leaves the app", async () => {
    const m = await started();
    await m.run("/exit");
    expect(m.exits).toEqual(["exit"]);
  });

  test("/exit works while a turn runs: it cancels first", async () => {
    const m = await running();
    await m.run("/exit");
    expect(m.bridge.controls.some((c) => c.method === "chat.cancel")).toBe(true);
    m.bridge.lastStream.finish({ cancelled: true }); // the engine saves the session, then ends the turn
    await settle();
    expect(m.exits).toEqual(["exit"]);
  });
});

describe("holding the session still", () => {
  /** A request the test releases by hand. */
  function hold(m: { bridge: MockBridge }, method: string): { release: (v: unknown) => void } {
    const h = { release: (_: unknown) => {} };
    const orig = m.bridge.request.bind(m.bridge);
    m.bridge.request = ((meth: string, params: Record<string, unknown> = {}) =>
      meth === method ? new Promise<unknown>((r) => (h.release = r)) : orig(meth, params)) as typeof m.bridge.request;
    return h;
  }

  test("while /model loads its lists, a typed prompt waits; the picker opens over no turn", async () => {
    const m = await started();
    const h = hold(m, "cloud.models");
    m.c.submit("/model");
    await settle();
    m.c.submit("hello");
    await settle();
    expect(m.bridge.streams).toEqual([]);
    expect(m.c.getState().queue).toEqual(["hello"]);
    h.release({ models: [] });
    await settle();
    expect(m.c.getState().phase).toBe("picker");
    expect(m.bridge.streams).toEqual([]);
    await m.c.pick(null); // closing the picker lets the prompt go
    await settle();
    expect(m.bridge.lastStream.params).toEqual({ text: "hello" });
  });

  test("a second /model while loading is refused", async () => {
    const m = await started();
    const h = hold(m, "cloud.models");
    m.c.submit("/model");
    await settle();
    const before = m.bridge.to("models.installed").length;
    expect(await m.run("/model")).toEqual(["still loading the model list"]);
    expect(m.bridge.to("models.installed")).toHaveLength(before);
    h.release({ models: [] });
    await settle();
    expect(m.c.getState().picker!.kind).toBe("model");
  });

  test("other session commands wait for the list too", async () => {
    const m = await started();
    const h = hold(m, "cloud.models");
    m.c.submit("/model");
    await settle();
    expect(await m.run("/clear")).toEqual(["still loading the model list"]);
    expect(await m.run("/compact")).toEqual(["still loading the model list"]);
    h.release({ models: [] });
    await settle();
  });

  test("a prompt typed while /sessions loads waits as well", async () => {
    const m = await started();
    const h = hold(m, "code.sessions");
    m.c.submit("/sessions");
    await settle();
    m.c.submit("hello");
    await settle();
    expect(m.bridge.streams).toEqual([]);
    h.release({ sessions: [{ id: "a", title: "x", turns: 1, updated: "" }] });
    await settle();
    expect(m.c.getState().phase).toBe("picker");
    expect(m.bridge.streams).toEqual([]);
  });

  test("with a picker open, session commands are refused and the picker stays", async () => {
    const m = await started();
    m.bridge.answers["code.sessions"] = { sessions: [{ id: "a", title: "x", turns: 1, updated: "" }] };
    await m.run("/sessions");
    const picker = m.c.getState().picker;
    for (const cmd of ["/compact", "/resume zz", "/clear", "/model", "/sessions", "/undo"]) {
      expect(await m.run(cmd)).toEqual(["choose or cancel the picker first"]);
    }
    expect(m.c.getState().picker).toBe(picker);
    expect(m.c.getState().phase).toBe("picker");
    expect(m.bridge.streams).toEqual([]);
    expect(m.bridge.to("code.resume")).toEqual([]);
    expect(m.bridge.to("code.undo")).toEqual([]);
  });

  test("with the undo question open, session commands are refused and the question stays", async () => {
    const m = await started();
    m.bridge.answers["code.undo"] = { restore: ["a.py"], delete: [], conflicts: [], shell_not_reverted: [], skipped: [], applied: false };
    await m.run("/undo");
    for (const cmd of ["/compact", "/resume zz", "/clear", "/model x"]) expect(await m.run(cmd)).toEqual(["answer the undo question first"]);
    expect(m.c.getState().confirm).not.toBeNull();
    expect(m.bridge.streams).toEqual([]);
  });

  test("a prompt waiting behind a picker goes out when the picker closes", async () => {
    const m = await started();
    m.bridge.answers["code.sessions"] = { sessions: [{ id: "a", title: "x", turns: 1, updated: "" }] };
    await m.run("/sessions");
    m.c.submit("later");
    await settle();
    expect(m.bridge.streams).toEqual([]);
    await m.c.pick(null);
    await settle();
    expect(m.bridge.lastStream.params).toEqual({ text: "later" });
  });

  test("/resume <id> of the current session says so", async () => {
    const m = await started();
    expect(await m.run("/resume s-gemma4:cloud")).toEqual(["that's the current session"]);
    expect(m.bridge.to("code.resume")).toEqual([]);
    expect(m.c.getState().phase).toBe("idle");
  });
});
