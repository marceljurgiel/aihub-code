// Ported from AIhub-TUI v1.5.0 app/src/agent.test.tsx.
// aihub-code: the window is opened as a panel opens it; a choice goes to
// onChoose. Not ported (ChatScreen's, rewritten against the controller in
// Task 5): the agent.check and the chat note after a choice, and the chat turn
// carrying the agent's name.
import { test, expect, afterEach } from "bun:test";
import { AgentModal, type AgentChoice } from "./modals/AgentModal.tsx";
import { MockBridge, openWindow, type Opened } from "./test-tree.tsx";

let setup: Opened["setup"] | undefined;
let win: Opened | undefined;
let choices: AgentChoice[] = [];
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

async function settle(n = 4) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 25));
    await setup!.flush();
  }
}

const AGENTS = [
  { name: "coder", description: "Writes and fixes code", prompt: "You code.", tools: ["read_file", "edit_file", "run_terminal"],
    permission: "auto", model: "", context: 0, builtin: true, path: "" },
  { name: "researcher", description: "Searches the web", prompt: "You research.", tools: ["read_file", "search_web"],
    permission: "ask", model: "qwen3:8b", context: 0, builtin: true, path: "" },
];

class AgentBridge extends MockBridge {
  calls: Array<[string, any]> = [];
  agents = [...AGENTS];
  override async request(method: string, params: any = {}): Promise<any> {
    this.calls.push([method, params]);
    switch (method) {
      case "agents.list":
        return { agents: this.agents, dir: "/home/me/.aihub/agents" };
      case "agent.check":
        return { ok: true, context: 14336, context_note: "most that fits in GPU 8 GB (learned)", max_context: 40960 };
      case "agents.draft":
        return { agent: { name: "homeserver-watch", description: "Watches the server", prompt: "You watch home server.\nNever reboot.",
                          tools: ["run_terminal", "read_file"], permission: "ask", model: "", context: 0, builtin: false, path: "" } };
      case "agents.save": {
        const a = { ...params.agent, path: `/home/me/.aihub/agents/${params.agent.name}.md` };
        this.agents.push(a);
        return { agent: a };
      }
      default:
        return super.request(method);
    }
  }
}

async function boot() {
  const bridge = new AgentBridge();
  choices = [];
  win = await openWindow(
    bridge,
    (close) => (
      <AgentModal current={null} model="llama3.2:3b" backend="ollama" streamModel="llama3.2:3b" onChoose={(c) => choices.push(c)} onClose={close} />
    ),
    { width: 110, height: 34 },
  );
  setup = win.setup;
  return bridge;
}

async function openAgents() {
  if (!win!.isOpen()) win!.reopen();
  await until((f) => f.includes("Agents") && f.includes("researcher"));
}

test("lists chat + agents; picking one chooses it in build mode and closes", async () => {
  await boot();
  await openAgents();
  setup!.mockInput.pressArrow("down");
  await settle();
  setup!.mockInput.pressArrow("down");
  await settle();
  setup!.mockInput.pressEnter();
  await until(() => !win!.isOpen());
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({ kind: "agent", submode: "build", agent: { name: "researcher" } });
});

test("p starts an agent in plan mode; choosing chat goes back", async () => {
  await boot();
  await openAgents();
  setup!.mockInput.pressArrow("down");
  await settle();
  setup!.mockInput.pressKey("p");
  await until(() => !win!.isOpen());
  expect(choices[0]).toMatchObject({ kind: "agent", submode: "plan", agent: { name: "coder" } });
  await openAgents();
  await settle();
  setup!.mockInput.pressEnter();             // row 0: chat
  await until(() => !win!.isOpen());
  expect(choices[1]).toEqual({ kind: "chat" });
});

test("n drafts a new agent from a description, review, save", async () => {
  const bridge = await boot();
  await openAgents();
  setup!.mockInput.pressKey("n");
  await until((x) => x.includes("Describe the agent"));
  await setup!.mockInput.typeText("pilnuj mojego serwera");
  await settle();
  setup!.mockInput.pressEnter();
  let f = await until((x) => x.includes("You watch home server."));
  expect(f).toContain("homeserver-watch");
  expect(f).toContain("shell");
  expect(f).toContain("asks first");
  setup!.mockInput.pressKey("a");               // toggle → auto
  await until((x) => x.includes("auto — runs without asking"));
  setup!.mockInput.pressEnter();
  f = await until((x) => x.includes("Saved /home/me/.aihub/agents/homeserver-watch.md"));
  expect(bridge.calls.filter(([m]) => m === "agents.draft")).toHaveLength(1);
  expect(bridge.calls.find(([m]) => m === "agents.save")![1].agent.permission).toBe("auto");
});

