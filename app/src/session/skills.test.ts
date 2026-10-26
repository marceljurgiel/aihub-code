import { afterEach, describe, expect, test } from "bun:test";
import type { Args } from "../args";
import { commandTable } from "../commands";
import { mount, unmount, until, type Mounted } from "../footer/test-utils";
import { slashMatches } from "../footer/SlashSuggest";
import { G } from "../glyphs";
import { memorySink } from "../scrollback";
import { Controller } from "./controller";
import { MockBridge } from "./mock-bridge";

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const SYS = { role: "system", content: "You are AIhub." };
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
const content = (p: Record<string, unknown>) => `Use the "${p.name}" skill for this. <skill>…</skill>\n\nTask: ${p.task}`;

async function started() {
  const bridge = new MockBridge();
  bridge.answers["config.get"] = { default_chat_model: "gemma4:cloud", default_context_length: 2048 };
  bridge.answers["code.start"] = INFO;
  bridge.answers["chat.start"] = { messages: [SYS] };
  bridge.answers["chat.finalize"] = {};
  bridge.answers["hardware.recommend_context"] = { context: 4096 };
  bridge.answers["skills.invoke"] = (p: Record<string, unknown>) => (p.name === "review" ? { content: content(p), skill: { name: "review" } } : new Error(`unknown skill: ${p.name}`));
  const sink = memorySink();
  const c = new Controller({ bridge, sink, commands: commandTable(), now: () => 1000, width: () => 100, cwd: "/home/alex/proj", home: "/home/alex" });
  await c.start(ARGS);
  const text = () => sink.lines.join("\n");
  const run = async (line: string) => {
    c.submit(line);
    await settle();
  };
  return { bridge, sink, c, text, run };
}

describe("/skill <name> [task]", () => {
  test("under code: skills.invoke {name, task, context_length} → code.turn whose text is the skill's content; the echo is what was typed", async () => {
    const m = await started();
    await m.run("/skill review fix it");
    expect(m.bridge.to("skills.invoke")[0]!.params).toEqual({ name: "review", task: "fix it", context_length: 8192 });
    const turn = m.bridge.lastStream;
    expect(turn.method).toBe("code.turn");
    expect(turn.params).toEqual({ text: content({ name: "review", task: "fix it" }) });
    expect(m.text()).toContain("> /skill review fix it");
    // The model's instructions are not the transcript's.
    expect(m.text()).not.toContain("<skill>");
  });

  test("under chat: the user message's content is the skill's content (chat's context size)", async () => {
    const m = await started();
    await m.c.setKind({ type: "chat" });
    await m.run("/skill review");
    expect(m.bridge.to("skills.invoke")[0]!.params).toEqual({ name: "review", task: "", context_length: 4096 });
    const turn = m.bridge.lastStream;
    expect(turn.method).toBe("chat.turn");
    expect((turn.params.messages as unknown[]).at(-1)).toEqual({ role: "user", content: content({ name: "review", task: "" }) });
    expect(m.text()).toContain("> /skill review");
  });

  test("an unknown skill: the error comes back as an error line, no turn", async () => {
    const m = await started();
    await m.run("/skill nope do it");
    expect(m.text()).toContain(`${G.cross} Using skill nope failed: unknown skill: nope`);
    expect(m.bridge.streams).toHaveLength(0);
    expect(m.c.getState().phase).toBe("idle");
    await m.run("hello");
    expect(m.bridge.lastStream.params).toEqual({ text: "hello" });
  });

  test("/skill alone opens the skills window", async () => {
    const m = await started();
    await m.run("/skill");
    expect(m.c.getState().panel).toEqual({ id: "skills" });
  });

  test("while a turn runs it is refused with a note (no skills.invoke)", async () => {
    const m = await started();
    await m.run("go");
    await m.run("/skill review");
    expect(m.bridge.to("skills.invoke")).toHaveLength(0);
    expect(m.text()).toContain("wait for the current turn to finish");
  });

  test("a prompt typed while the skill is fetched goes out after the skill's turn", async () => {
    const m = await started();
    let answer!: (v: unknown) => void;
    m.bridge.answers["skills.invoke"] = () => new Promise((r) => (answer = r));
    m.c.submit("/skill review");
    m.c.submit("then this");
    await settle();
    expect(m.bridge.streams).toHaveLength(0);
    answer({ content: "SKILL" });
    await settle();
    expect(m.bridge.lastStream.params).toEqual({ text: "SKILL" });
    m.bridge.lastStream.finish({});
    await settle();
    expect(m.bridge.lastStream.params).toEqual({ text: "then this" });
  });
});

describe("skill suggestions", () => {
  test("slashMatches: a two-word name matches once the first word is typed; nothing after a trailing space", () => {
    const cmds = [{ name: "skill", hint: "" }, { name: "skills", hint: "" }, { name: "skill commit", hint: "Write a commit" }, { name: "model", hint: "" }];
    expect(slashMatches("/sk", cmds).map((c) => c.name)).toEqual(["skill", "skills", "skill commit"]);
    expect(slashMatches("/skill c", cmds).map((c) => c.name)).toEqual(["skill commit"]);
    expect(slashMatches("/skill commit ", cmds)).toEqual([]);
    expect(slashMatches("/skill commit now", cmds)).toEqual([]);
    expect(slashMatches("/model gemma", cmds)).toEqual([]);
  });

  test("refreshSkills keeps the enabled skills for the footer; the window's onChanged replaces them", async () => {
    const m = await started();
    m.bridge.answers["skills.list"] = { skills: [{ name: "commit", description: "Write a commit message.", enabled: true }, { name: "off", description: "x", enabled: false }] };
    await m.c.refreshSkills();
    expect(m.c.getState().skills).toEqual([{ name: "commit", description: "Write a commit message." }]);
    m.c.skillsChanged([{ name: "pdf", description: "PDF tools", enabled: true }]);
    expect(m.c.getState().skills).toEqual([{ name: "pdf", description: "PDF tools" }]);
  });
});

describe("the skills panel", () => {
  let m: Mounted | undefined;
  afterEach(() => {
    unmount(m);
    m = undefined;
  });
  const SKILLS = [{ name: "commit", description: "Write a commit message.", path: "/x", source: "builtin", files: [], enabled: true }];
  const boxText = (mm: Mounted) => mm.lines().find((l) => /^\s*│\s*>/.test(l)) ?? "";

  test("onUse closes the window and puts `/skill <name> ` into the prompt", async () => {
    m = await mount({ width: 120, height: 36, rows: 36, answers: { "skills.list": { skills: SKILLS, dir: "/home/alex/.aihub/skills" } } });
    const mm = m;
    mm.c.openPanel("skills");
    await until(() => mm.frame().includes("commit"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.c.getState().panel === null, mm.settle);
    await until(() => boxText(mm).includes("/skill commit"), mm.settle);
    expect(mm.sink.lines.join("\n")).not.toContain("coming in this release");
    // The cursor is at the end: what is typed next is the task.
    await mm.setup.mockInput.typeText("tidy up");
    await mm.settle();
    expect(boxText(mm)).toContain("/skill commit tidy up");
  });

  test("prefill while the prompt shows replaces its text", async () => {
    m = await mount({ width: 100 });
    const mm = m;
    await mm.setup.mockInput.typeText("draft");
    await mm.settle();
    mm.c.prefill("/skill commit ");
    await until(() => boxText(mm).includes("/skill commit"), mm.settle);
    expect(boxText(mm)).not.toContain("draft");
  });

  test("the footer suggests `/skill <name>` for enabled skills", async () => {
    m = await mount({ width: 100, commands: [{ name: "skill", hint: "Use a skill" }], answers: { "skills.list": { skills: SKILLS } } });
    const mm = m;
    await mm.c.refreshSkills();
    await mm.setup.mockInput.typeText("/skill c");
    await until(() => mm.frame().includes("/skill commit"), mm.settle);
    expect(mm.frame()).toContain("Write a commit message.");
  });
});
