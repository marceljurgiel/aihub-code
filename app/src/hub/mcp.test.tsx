// Ported from AIhub-TUI v1.5.0 app/src/mcp.test.tsx.
// aihub-code: the window is opened as a panel opens it. Not ported: the tool
// card / approval labels (AIhub's ToolPanel and PermissionModal, not windows
// aihub-code has).
import { test, expect, afterEach } from "bun:test";
import { McpModal } from "./modals/McpModal.tsx";
import { MockBridge, openWindow, type Opened } from "./test-tree.tsx";

let setup: Opened["setup"] | undefined;
let win: Opened | undefined;
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
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 25));
    await setup!.flush();
  }
};

const GMAIL = {
  name: "gmail", enabled: true, status: "connected", error: "", transport: "stdio",
  command: "/home/me/.aihub/mcp/venvs/workspace-mcp/bin/workspace-mcp --tools gmail --single-user",
  keywords: ["mail", "inbox"],
  tools: [
    { name: "search_gmail_messages", description: "Searches messages.", read_only: true, enabled: true },
    { name: "send_gmail_message", description: "Sends an email.", read_only: false, enabled: true },
    { name: "manage_gmail_filter", description: "Filters.", read_only: false, enabled: false },
  ],
};

class McpBridge extends MockBridge {
  calls: Array<[string, any]> = [];
  google = { connected: false, email: "", builtin: true, own_client: false };
  /** How google.connect ends: done (with the account), an error, or stays waiting. */
  connectEnds: "done" | "error" | "wait" = "done";
  clientFound = false;
  revokes = true;
  servers: any[] = [GMAIL, { ...GMAIL, name: "broken", status: "error", error: "command not found: npx", tools: [] }];
  override async request(method: string, params: any = {}): Promise<any> {
    this.calls.push([method, params]);
    switch (method) {
      case "mcp.list":
        return { servers: this.servers.map((s) => ({ ...s })), config: "/home/me/.aihub/mcp.json" };
      case "mcp.tool_enable":
      case "mcp.enable":
        return { ok: true };
      case "mcp.add":
        return { added: { everything: { ok: true, tools: 13 } } };
      case "mcp.catalog":
        return { items: [
          { id: "github", name: "GitHub", category: "code", description: "Repos, issues, PRs", installed: false, prefill: {},
            fields: [{ key: "token", label: "GitHub token", secret: true, placeholder: "ghp_…" }], steps: ["github.com/settings/tokens"] },
          { id: "google", name: "Google", category: "google", description: "Gmail, Calendar and Drive — sign in once",
            installed: true, prefill: {}, fields: [], steps: [], connect: "google" },
          { id: "fetch", name: "Fetch (web pages)", category: "web", description: "Read a web page", installed: false, prefill: {},
            fields: [], steps: [] },
        ], claude: ["obsidian"] };
      case "mcp.install":
        return { ok: true, name: params.id, tools: params.id === "fetch" ? 1 : 26 };
      case "mcp.import_claude":
        return { added: ["obsidian"], skipped: [] };
      case "google.status":
        return { ...this.google, client: "", services: [] };
      case "google.own_steps":
        return { steps: [1, 2, 3, 4].map((n) => ({ text: `step ${n}`, url: `https://console.cloud.google.com/s${n}` })) };
      case "google.import_client":
        return this.clientFound ? { found: true, client_id: "x" } : { found: false };
      case "google.disconnect":
        this.google = { ...this.google, connected: false, email: "" };
        return { revoked: this.revokes, removed: ["gmail"] };
      default:
        return super.request(method);
    }
  }
  override stream(method: string, params: any, handlers: any): { id: number; done: Promise<any> } {
    if (method !== "google.connect") return super.stream(method, params, handlers);
    this.calls.push([method, params]);
    const done: Promise<any> = (async (): Promise<any> => {
      await new Promise((r) => setTimeout(r, 30));
      handlers.onEvent("opening", { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", opened: true });
      handlers.onEvent("waiting", {});
      if (this.connectEnds === "wait") return new Promise(() => {});
      await new Promise((r) => setTimeout(r, 30));
      if (this.connectEnds === "error") throw new Error("no answer from Google — the sign-in page was closed or timed out");
      handlers.onEvent("installing", { service: "gmail" });
      this.google = { ...this.google, connected: true, email: "alex@example.com" };
      return { email: "alex@example.com", services: ["gmail", "calendar", "drive"], missing: [], client: "builtin" };
    })();
    return { id: 77, done };
  }
}

async function open() {
  const bridge = new McpBridge();
  win = await openWindow(bridge, (close) => <McpModal onClose={close} />, { width: 110, height: 34 });
  setup = win.setup;
  await until((f) => f.includes("Connections") && f.includes("gmail"));
  return bridge;
}

test("lists servers with status, tool counts and errors", async () => {
  const bridge = await open();
  const f = setup!.captureCharFrame();
  expect(f).toMatch(/ gmail\s+connected\s+2\/3 tools/);
  expect(f).not.toMatch(/[●○◌]/);
  expect(f).toContain("used when you mention: gmail, mail, inbox");
  setup!.mockInput.pressArrow("down");
  await until((x) => x.includes("command not found: npx"));
  expect(bridge.calls.some(([m, p]) => m === "mcp.list" && p.connect)).toBe(true);
});

test("enter shows tools (reads / changes); t switches one off", async () => {
  const bridge = await open();
  setup!.mockInput.pressEnter();
  const f = await until((x) => x.includes("send_gmail_message"));
  expect(f).toMatch(/search_gmail_messages\s+reads/);
  expect(f).toMatch(/send_gmail_message\s+changes/);
  setup!.mockInput.pressKey("t");
  await settle();
  expect(bridge.calls).toContainEqual(["mcp.tool_enable", { name: "gmail", tool: "search_gmail_messages", enabled: false }]);
});

async function openCatalog() {
  setup!.mockInput.pressKey("a");
  await until((x) => x.includes("Import from Claude") && x.includes("Custom (MCP)…"));
}

const down = async (n: number) => {
  for (let i = 0; i < n; i++) {
    setup!.mockInput.pressArrow("down");
    await settle();
  }
};

test("a opens the catalog; a server with nothing to fill installs on enter", async () => {
  const bridge = await open();
  await openCatalog();
  const f = setup!.captureCharFrame();
  expect(f).toMatch(/✓ Google/);                                         // installed marker
  await down(2);
  expect(setup!.captureCharFrame()).toContain("needs: nothing — enter installs it");
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("Fetch (web pages) connected — 1 tools"));
  expect(bridge.calls).toContainEqual(["mcp.install", { id: "fetch", values: {} }]);
});

test("a server that needs a token asks for it with the steps", async () => {
  const bridge = await open();
  await openCatalog();
  setup!.mockInput.pressEnter();                                         // GitHub
  await until((x) => x.includes("GitHub token (1/1)") && x.includes("github.com/settings/tokens"));
  await setup!.mockInput.typeText("ghp_fake-test-token");
  await settle();
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("GitHub connected — 26 tools"));
  expect(bridge.calls).toContainEqual(["mcp.install", { id: "github", values: { token: "ghp_fake-test-token" } }]);
});

test("Google connects in one click: sign-in in the browser, then ready", async () => {
  const bridge = await open();
  await openCatalog();
  await down(1);                                                          // Google
  await until((x) => x.includes("needs: just your Google sign-in"));
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("Connected as alex@example.com"));
  expect(setup!.captureCharFrame()).toContain("Gmail, Calendar, Drive ready");
  expect(bridge.calls).toContainEqual(["google.connect", { own: false }]);
  expect(bridge.calls.some(([m]) => m === "mcp.install")).toBe(false);   // no form, no pasted keys
});

test("without AIhub's Google app, the wizard picks up the downloaded client", async () => {
  const bridge = await open();
  bridge.google = { ...bridge.google, builtin: false };
  await openCatalog();
  await down(1);
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("Your own Google app") && x.includes("step 4") && x.includes("Waiting for client_secret"));
  setup!.mockInput.pressKey("2");
  await until(() => bridge.calls.some(([m, p]) => m === "system.open_url" && p.url.endsWith("/s2")));
  bridge.clientFound = true;                                              // the user downloads the JSON
  await until((x) => x.includes("Connected as alex@example.com"), 120);
  expect(bridge.calls).toContainEqual(["google.connect", { own: true }]);
});

test("a failed sign-in explains itself and offers your own app", async () => {
  const bridge = await open();
  bridge.connectEnds = "error";
  await openCatalog();
  await down(1);
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("Google sign-in didn't finish") && x.includes("use my own Google app"));
  setup!.mockInput.pressKey("o");
  await until((x) => x.includes("Your own Google app"));
});

test("d on a Google service disconnects Google after a confirmation", async () => {
  const bridge = await open();
  bridge.google = { connected: true, email: "alex@example.com", builtin: true, own_client: false };
  setup!.mockInput.pressEscape();
  await settle();
  win!.reopen();
  await until((x) => x.includes("Google · alex@example.com"));
  setup!.mockInput.pressKey("d");
  await until((x) => x.includes("Press d again to disconnect Google"));
  setup!.mockInput.pressKey("d");
  await until((x) => x.includes("Google disconnected"));
  expect(setup!.captureCharFrame()).toContain("revoked at Google");
  expect(bridge.calls.some(([m]) => m === "google.disconnect")).toBe(true);
  expect(bridge.calls.some(([m]) => m === "mcp.remove")).toBe(false);
});

test("a disconnect that couldn't reach Google doesn't claim the access was revoked", async () => {
  const bridge = await open();
  bridge.google = { connected: true, email: "alex@example.com", builtin: true, own_client: false };
  bridge.revokes = false;
  setup!.mockInput.pressEscape();
  await settle();
  win!.reopen();
  await until((x) => x.includes("Google · alex@example.com"));
  setup!.mockInput.pressKey("d");
  await until((x) => x.includes("Press d again to disconnect Google"));
  setup!.mockInput.pressKey("d");
  const f = await until((x) => x.includes("Google disconnected"));
  expect(f).not.toContain("revoked at Google");
  expect(f).toContain("myaccount.google.com/permissions");
});

test("import from Claude and custom servers are in the catalog too", async () => {
  const bridge = await open();
  await openCatalog();
  await down(3);
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("Imported obsidian"));
  expect(bridge.calls.some(([m]) => m === "mcp.import_claude")).toBe(true);
  await openCatalog();
  await down(4);
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("Paste a server's config"));
  await setup!.mockInput.pasteBracketedText("npx -y @modelcontextprotocol/server-everything");
  await settle();
  setup!.mockInput.pressEnter();
  await until((x) => x.includes("everything: 13 tools"));
});

