// Ported from AIhub-TUI v1.5.0 app/src/skills.test.tsx.
// aihub-code: the window is opened as a panel opens it; Enter goes to onUse.
// Not ported (ChatScreen's; Task 6 rewrites them against the controller):
// /skill sending the instructions, /websearch, a turn without an answer.
import { test, expect, afterEach } from "bun:test";
import { SkillsModal } from "./modals/SkillsModal.tsx";
import { MockBridge, openWindow, type Opened } from "./test-tree.tsx";
import { parseSlash, filterSlash } from "./slash.ts";

let setup: Opened["setup"] | undefined;
let used: string[] = [];
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function until(pred: (f: string) => boolean, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await setup!.flush();
    const f = setup!.captureCharFrame();
    if (pred(f)) return f;
  }
  throw new Error("frame never matched:\n" + setup!.captureCharFrame());
}
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 25));
    await setup!.flush();
  }
};

const SKILLS = [
  { name: "commit", description: "Write a commit message. Use when asked to commit.", path: "/pkg/skills/commit",
    source: "builtin", files: [], enabled: true },
  { name: "invoice", description: "Create client invoices as PDF.", path: "/home/me/.aihub/skills/invoice",
    source: "user", files: ["template.md"], enabled: true },
];

class SkillBridge extends MockBridge {
  calls: Array<[string, any]> = [];
  skills = SKILLS.map((s) => ({ ...s }));
  turns: any[] = [];
  override async request(method: string, params: any = {}): Promise<any> {
    this.calls.push([method, params]);
    switch (method) {
      case "skills.list":
        return { skills: this.skills.map((s) => ({ ...s })), dir: "/home/me/.aihub/skills" };
      case "skills.get":
        return { skill: { ...this.skills.find((s) => s.name === params.name), body: "1. Run git status.\n2. Write it." } };
      case "skills.enable":
        this.skills.find((s) => s.name === params.name)!.enabled = params.enabled;
        return { ok: true };
      case "skills.invoke":
        return { content: `Use the "${params.name}" skill for this. <skill>…</skill>\n\nTask: ${params.task}` };
      case "skills.draft":
        return { draft: { name: "weekly-report", description: "Weekly report from git. Use on Fridays.", instructions: "1. git log --since=1.week" } };
      case "skills.save":
        this.skills.push({ name: params.name, description: params.description, path: `/home/me/.aihub/skills/${params.name}`,
                           source: "user", files: [], enabled: true });
        return { skill: this.skills.at(-1) };
      case "skills.install":
        if (params.source.includes("bad")) throw new Error("no SKILL.md found there");
        this.skills.push({ name: "pdf", description: "PDF tools", path: "/home/me/.aihub/skills/pdf", source: "user", files: [], enabled: true });
        return { installed: [this.skills.at(-1)] };
      case "skills.search":
        return { results: [
          { name: "pdf", repo: "anthropics/skills", description: "Work with PDF files.", installs: 204741, stars: 0,
            url: "https://github.com/anthropics/skills/tree/main/skills/pdf", page: "", directory: "skills.sh", installed: false },
          { name: "nano-pdf", repo: "openclaw/openclaw", description: "Edit PDFs.", installs: 0, stars: 390831,
            url: "https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf", page: "", directory: "SkillsMP", installed: false },
        ], errors: { SkillsMP: "SkillsMP: daily search limit reached (50/day without a key)" } };
      case "skills.preview":
        return { preview: { name: params.name, description: "Work with PDF files.", body: "## Steps\nRun scripts/fill.py",
                            repo: params.repo, folder: "skills/pdf", files: ["forms.md", "scripts/fill.py"],
                            scripts: ["scripts/fill.py"], size: 58692,
                            source_url: "https://github.com/anthropics/skills/tree/main/skills/pdf" } };
      case "skills.install_remote":
        this.skills.push({ name: params.name, description: "Work with PDF files.", path: `/home/me/.aihub/skills/${params.name}`,
                           source: "user", files: ["forms.md"], enabled: true });
        return { skill: this.skills.at(-1) };
      default:
        return super.request(method);
    }
  }
  override stream(method: string, params: any, handlers: any) {
    this.turns.push(params);
    return { id: 1, done: Promise.resolve({ messages: params.messages }) } as any;
  }
}

async function boot() {
  const bridge = new SkillBridge();
  used = [];
  const win = await openWindow(
    bridge,
    (close) => (
      <SkillsModal model="llama3.2:3b" backend="ollama" streamModel="llama3.2:3b" onUse={(n) => used.push(n)} onChanged={() => {}} onClose={close} />
    ),
    { width: 110, height: 34 },
  );
  setup = win.setup;
  return bridge;
}

async function openSkills() {
  await until((f) => f.includes("Skills") && f.includes("invoice"));
}

test("parse and suggest", () => {
  expect(parseSlash("/skills").kind).toBe("skills");
  expect(parseSlash("/skill commit only the message")).toEqual({ kind: "skill", payload: { key: "commit", value: "only the message" } });
  expect(filterSlash("/skill in", [{ cmd: "/skill invoice", desc: "x" }]).map((c) => c.cmd)).toContain("/skill invoice");
});

test("lists skills; enter uses the selected one (/skill <name> in the prompt)", async () => {
  await boot();
  await openSkills();
  setup!.mockInput.pressArrow("down");
  await settle();
  setup!.mockInput.pressEnter();
  await until(() => used.length > 0);
  expect(used).toEqual(["invoice"]);
});


test("t turns a skill off; v shows its instructions", async () => {
  const bridge = await boot();
  await openSkills();
  setup!.mockInput.pressKey("t");
  await until((f) => f.includes("[ ] commit"));
  expect(bridge.calls).toContainEqual(["skills.enable", { name: "commit", enabled: false }]);
  setup!.mockInput.pressKey("v");
  await until((f) => f.includes("1. Run git status."));
});

test("n drafts a skill, enter saves it", async () => {
  const bridge = await boot();
  await openSkills();
  setup!.mockInput.pressKey("n");
  await until((f) => f.includes("Describe the skill"));
  await setup!.mockInput.typeText("raport tygodniowy z gita");
  await settle();
  setup!.mockInput.pressEnter();
  await until((f) => f.includes("git log --since=1.week"));
  setup!.mockInput.pressEnter();
  await until((f) => f.includes("Saved /home/me/.aihub/skills/weekly-report/SKILL.md"));
  expect(bridge.calls.filter(([m]) => m === "skills.draft")).toHaveLength(1);
  expect(bridge.calls.find(([m]) => m === "skills.save")![1]).toMatchObject({ name: "weekly-report" });
});

test("i installs from a link; errors are shown", async () => {
  await boot();
  await openSkills();
  setup!.mockInput.pressKey("i");
  await until((f) => f.includes("Install from a GitHub folder link"));
  await setup!.mockInput.typeText("https://github.com/x/bad");
  await settle();
  setup!.mockInput.pressEnter();
  await until((f) => f.includes("no SKILL.md found there"));
  setup!.mockInput.pressKey("a", { ctrl: true });
  await setup!.mockInput.typeText("https://github.com/anthropics/skills/tree/main/skills/pdf");
  await settle();
  setup!.mockInput.pressEnter();
  await until((f) => f.includes("Installed pdf."));
});

test("s searches the online directories, previews and installs", async () => {
  const bridge = await boot();
  await openSkills();
  setup!.mockInput.pressKey("s");
  await until((f) => f.includes("search skills.sh + SkillsMP"));
  await setup!.mockInput.typeText("pdf");
  await settle();
  setup!.mockInput.pressEnter();
  let f = await until((x) => x.includes("anthropics/skills") && x.includes("205k inst"));
  expect(f).toContain("★391k");
  expect(f).toContain("daily search limit");          // one directory failing is shown, not fatal
  setup!.mockInput.pressEnter();                       // same query → preview the selected one
  f = await until((x) => x.includes("Run scripts/fill.py"));
  expect(f).toContain("⚠ 1 scripts");
  setup!.mockInput.pressEnter();                       // install
  await until((x) => x.includes("Installed pdf from anthropics/skills"));
  expect(bridge.calls.filter(([m]) => m === "skills.search")).toHaveLength(1);
  expect(bridge.calls.find(([m]) => m === "skills.install_remote")![1]).toMatchObject({ repo: "anthropics/skills", name: "pdf" });
});


