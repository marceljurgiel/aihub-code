import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { fmtToolCall, fmtToolResult, fmtUser } from "./transcript/format";
import { Controller } from "./session/controller";
import { MockBridge } from "./session/mock-bridge";
import { commandTable } from "./commands";
import { Transcript, memorySink, rendererSink } from "./scrollback";
import { lineText } from "./width";
import { debounced, exitLine, footerBudget, messagesToLines } from "./replay";

const text = (lines: ReturnType<typeof messagesToLines>) => lines.map(lineText);

const CALL = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: args } });
const TOOL = (id: string, name: string, content: string) => ({ role: "tool", tool_call_id: id, tool_name: name, content });

describe("messagesToLines (resume replay)", () => {
  test("system messages are skipped; a user prompt reads like a live one", () => {
    const out = text(messagesToLines([{ role: "system", content: "You are…" }, { role: "user", content: "fix it" }], 60));
    expect(out).toEqual(["", "> fix it"]);
    expect(out.slice(1)).toEqual(fmtUser("fix it", 60).map(lineText));
  });

  test("assistant text is rendered as markdown, like a streamed reply", () => {
    const out = text(messagesToLines([{ role: "assistant", content: "Done: **add** works\n\n```\nx = 1\n```" }], 60));
    expect(out.join("\n")).toContain("Done: add works");
    expect(out.join("\n")).not.toContain("**");
    expect(out.join("\n")).toContain("x = 1");
  });

  test("a tool call is paired with its result by id", () => {
    const msgs = [
      { role: "user", content: "look" },
      { role: "assistant", content: "", tool_calls: [CALL("a", "read_file", { path: "calc.py" }), CALL("b", "run_terminal", { command: "pytest -q" })] },
      TOOL("a", "read_file", "    1\tx\n    2\ty"),
      TOOL("b", "run_terminal", "1 failed\n[Exit: 1]"),
      { role: "assistant", content: "It failed." },
    ];
    const out = text(messagesToLines(msgs, 60));
    const call = fmtToolCall({ name: "read_file", arguments: { path: "calc.py" } }, 60).map(lineText);
    const result = fmtToolResult({ name: "read_file", result: "    1\tx\n    2\ty" }, 60).map(lineText);
    expect(out).toEqual([
      "",
      "> look",
      ...call,
      ...result,
      ...fmtToolCall({ name: "run_terminal", arguments: { command: "pytest -q" } }, 60).map(lineText),
      ...fmtToolResult({ name: "run_terminal", result: "1 failed\n[Exit: 1]" }, 60).map(lineText),
      "It failed.",
    ]);
  });

  test("tool arguments may arrive as a JSON string", () => {
    const out = text(
      messagesToLines([{ role: "assistant", content: "", tool_calls: [CALL("a", "read_file", '{"path":"calc.py"}')] }, TOOL("a", "read_file", "(empty file)")], 60),
    );
    expect(out[0]).toContain("read_file calc.py");
  });

  test("a call without a saved result still shows (a turn that was cut off)", () => {
    const out = text(messagesToLines([{ role: "assistant", content: "", tool_calls: [CALL("a", "read_file", { path: "x.py" })] }], 60));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("read_file x.py");
  });

  test("edits and writes say what happened; todos show the list", () => {
    const out = text(
      messagesToLines(
        [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              CALL("a", "edit_file", { path: "calc.py", old: "a - b", new: "a + b" }),
              CALL("b", "todo_write", { todos: [{ content: "fix add", status: "completed" }] }),
            ],
          },
          TOOL("a", "edit_file", "[Edit OK] Replaced 1 occurrence in /work/calc.py."),
          TOOL("b", "todo_write", "ok"),
        ],
        60,
      ),
    );
    expect(out.join("\n")).toContain("edit_file calc.py");
    expect(out.join("\n")).toMatch(/⎿ edited|\| edited/);
    expect(out.join("\n")).toContain("fix add");
  });

  test("denied and failed results look as they did live", () => {
    const out = text(
      messagesToLines(
        [
          { role: "assistant", content: "", tool_calls: [CALL("a", "edit_file", { path: "x" }), CALL("b", "read_file", { path: "gone" })] },
          TOOL("a", "edit_file", "[Denied by user] The user declined this edit_file call."),
          TOOL("b", "read_file", "[File Error] no such file: gone"),
        ],
        60,
      ),
    );
    expect(out.join("\n")).toContain("denied");
    expect(out.join("\n")).toContain("[File Error] no such file: gone");
  });

  test("a compaction summary and the undo note become one dim line each", () => {
    const out = text(
      messagesToLines(
        [
          { role: "user", content: "[Conversation summary]\n## Goal\nfix" },
          { role: "user", content: "[The user undid the file changes of that turn.]" },
          { role: "user", content: "next" },
        ],
        60,
      ),
    );
    expect(out.join("\n")).not.toContain("## Goal");
    expect(out.filter((l) => /summar/i.test(l))).toHaveLength(1);
    expect(out.filter((l) => /undid|undone/i.test(l))).toHaveLength(1);
    expect(out.at(-1)).toBe("> next");
  });

  test("odd messages never throw", () => {
    const odd: any[] = [null, 5, "x", {}, { role: "assistant" }, { role: "tool", content: 3 }, { role: "user", content: null }, { role: "assistant", content: "t", tool_calls: [null, {}] }];
    expect(() => messagesToLines(odd, 40)).not.toThrow();
  });

  test("no line is wider than the terminal", () => {
    const long = "word ".repeat(40);
    const lines = messagesToLines(
      [{ role: "user", content: long }, { role: "assistant", content: long, tool_calls: [CALL("a", "read_file", { path: "/very/long/path/".repeat(5) + "f.py" })] }, TOOL("a", "read_file", "x")],
      40,
    );
    for (const l of lines) expect(lineText(l).length).toBeLessThanOrEqual(40);
  });
});

describe("resuming a session writes the saved conversation into the scrollback", () => {
  test("the controller hands the messages over before anything else is typed", async () => {
    const bridge = new MockBridge();
    bridge.answers["config.get"] = { default_chat_model: "m" };
    bridge.answers["code.resume"] = {
      session_id: "s9",
      project: { root: "/home/alex/proj", branch: "main", is_git: true },
      mode: "build",
      model: "m",
      context_length: 1000,
      messages: [{ role: "system", content: "s" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi there" }],
    };
    const transcript = new Transcript();
    const sink = memorySink(transcript);
    const c = new Controller({
      bridge,
      sink,
      width: () => 60,
      cwd: "/home/alex/proj",
      home: "/home/alex",
      commands: commandTable(),
      onResume: (messages) => sink.write(messagesToLines(messages, 60)),
    });
    await c.start({ cont: false, mcp: [], kb: [], resume: "s9" });
    expect(sink.lines.join("\n")).toMatch(/aihub-code[\s\S]*> hello[\s\S]*hi there/);
    expect(transcript.all().map(lineText).join("\n")).toContain("> hello");
  });
});

describe("debounced", () => {
  test("a burst of calls runs the function once, after the quiet period", async () => {
    let n = 0;
    const d = debounced(() => n++, 20);
    d();
    d();
    d();
    expect(n).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(n).toBe(1);
  });

  test("cancel drops a pending call", async () => {
    let n = 0;
    const d = debounced(() => n++, 20);
    d();
    d.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(0);
  });
});

describe("footerBudget", () => {
  test("leaves at least 5 rows for the scrollback", () => {
    expect(footerBudget(30)).toBe(25);
    expect(footerBudget(20)).toBe(15);
  });
  test("a tiny terminal still gets the smallest usable footer", () => {
    expect(footerBudget(8)).toBeGreaterThanOrEqual(5);
    expect(footerBudget(3)).toBeGreaterThanOrEqual(5);
  });
});

describe("exitLine", () => {
  test("names the session to resume", () => {
    expect(exitLine("abc123")).toBe("Resume this session: aihub-code --resume abc123");
  });
  test("nothing without a session", () => {
    expect(exitLine("")).toBeNull();
  });
});

describe("a resize while a reply streams", () => {
  test("the replay loses and duplicates nothing, the controller's lines included", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12, screenMode: "split-footer", footerHeight: 3, externalOutputMode: "capture-stdout" });
    try {
      const transcript = new Transcript();
      const sink = rendererSink(
        {
          get width() {
            return setup.renderer.width;
          },
          createScrollbackSurface: (o) => setup.renderer.createScrollbackSurface(o),
          resetSplitFooterForReplay: () => setup.externalOutput.clear(),
        },
        transcript,
      );
      const bridge = new MockBridge();
      bridge.answers["config.get"] = { default_chat_model: "m" };
      bridge.answers["code.start"] = { session_id: "s", project: { root: "/p", is_git: true }, mode: "build", model: "m", context_length: 1000 };
      bridge.answers["models.installed"] = { models: [{ name: "m" }] };
      const c = new Controller({ bridge, sink, width: () => setup.renderer.width, cwd: "/p", home: "/h", commands: commandTable() });
      await c.start({ cont: false, mcp: [], kb: [] });
      c.submit("go");
      const s = bridge.lastStream;
      s.emit("text", { text: "first line\nsecond li" });
      await setup.flush();
      sink.replay({ clearSavedLines: true });
      s.emit("text", { text: "ne here\nthird\n" });
      s.finish({});
      await new Promise((r) => setTimeout(r, 20));
      await setup.flush();
      const rows = setup.externalOutput.take().flatMap((chunk) => chunk.rows.map((r) => r.trimEnd()));
      const joined = rows.join("\n");
      expect(joined.match(/first line/g)).toHaveLength(1);
      expect(joined.match(/> go/g)).toHaveLength(1);
      expect(joined).toContain("second line here");
      expect(joined).toContain("third");
    } finally {
      setup.renderer.destroy();
    }
  });
});
