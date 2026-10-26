import { afterEach, describe, expect, test } from "bun:test";
import { AppKeymapProvider } from "../hub/keymap/AppKeymap";
import { adaptBridge, BridgeProvider } from "../hub/state/BridgeContext";
import { mount, unmount, until, type Mounted } from "../footer/test-utils";
import { MockBridge } from "../session/mock-bridge";

let m: Mounted | undefined;
afterEach(() => {
  unmount(m);
  m = undefined;
});

const SERVER = { name: "gmail", enabled: true, status: "connected", error: "", transport: "stdio", command: "x", keywords: [], tools: [] };

async function mountPanels(answers: Record<string, unknown> = {}): Promise<Mounted> {
  return mount({
    width: 120,
    height: 36,
    rows: 36,
    answers: { "kb.list": { bases: [{ name: "docs", description: "", sources: [], chunks: 0 }] }, "mcp.list": { servers: [SERVER] }, ...answers },
    wrap: (footer, bridge) => (
      <AppKeymapProvider>
        <BridgeProvider client={adaptBridge(bridge)}>{footer}</BridgeProvider>
      </AppKeymapProvider>
    ),
  });
}

describe("the connection windows in the footer", () => {
  test("closing the knowledge window refreshes kb.list", async () => {
    m = await mountPanels();
    const mm = m;
    const before = mm.bridge.to("kb.list").length;
    mm.c.openPanel("knowledge");
    await until(() => mm.frame().includes("Knowledge"), mm.settle);
    mm.setup.mockInput.pressEscape();
    await until(() => mm.c.getState().panel === null && mm.bridge.to("kb.list").length > before, mm.settle);
  });

  test("closing the connections window reads the servers and tells the code session", async () => {
    m = await mountPanels({ "code.options": { mcp: true, knowledge: [] } });
    const mm = m;
    mm.c.openPanel("mcp");
    await until(() => mm.frame().includes("gmail"), mm.settle);
    mm.setup.mockInput.pressEscape();
    await until(() => mm.c.getState().panel === null, mm.settle);
    await until(() => mm.bridge.to("code.options").length === 1, mm.settle);
    expect(mm.bridge.to("code.options")[0]!.params).toEqual({ mcp: true });
  });

  test("Esc during the Google sign-in sends the routed chat.cancel, and the panel still works", async () => {
    m = await mountPanels({
      "mcp.catalog": {
        items: [{ id: "google", name: "Google", category: "google", description: "Gmail", installed: true, prefill: {}, fields: [], steps: [], connect: "google" }],
        claude: [],
      },
      "google.status": { connected: false, email: "", builtin: true, own_client: false, client: "", services: [] },
    });
    const mm = m;
    mm.c.openPanel("mcp");
    await until(() => mm.frame().includes("gmail"), mm.settle);
    mm.setup.mockInput.pressKey("a");
    await until(() => mm.frame().includes("Custom (MCP)"), mm.settle);
    mm.setup.mockInput.pressEnter();
    await until(() => mm.bridge.to("google.connect").length === 1, mm.settle);
    const stream = mm.bridge.lastStream;
    expect(stream.method).toBe("google.connect");
    stream.emit("waiting", {});
    await mm.settle();
    mm.setup.mockInput.pressEscape();
    await until(() => mm.bridge.controls.some((c) => c.method === "chat.cancel"), mm.settle);
    expect(mm.bridge.controls.find((c) => c.method === "chat.cancel")!.params).toEqual({ request_id: stream.id });
    // The panel is still there and answers keys: Esc backs out to the catalog, then the list.
    expect(mm.c.getState().panel?.id).toBe("mcp");
    stream.finish({ cancelled: true });
    await mm.settle();
    await until(() => mm.frame().includes("Custom (MCP)"), mm.settle); // the catalog again
    mm.setup.mockInput.pressEscape(); // → the list
    await mm.settle();
    mm.setup.mockInput.pressEscape(); // → closed
    await until(() => mm.c.getState().panel === null, mm.settle);
    mm.c.submit("/help");
    await until(() => mm.c.getState().panel?.id === "help", mm.settle);
  });
});
