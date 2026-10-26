// Ported from AIhub-TUI v1.5.0 app/src/test-tree.tsx.
/** @jsxImportSource ./jsx */
import { useState, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { BridgeProvider, type HubBridge } from "./state/BridgeContext.tsx";
import { ModalProvider } from "./state/ModalContext.tsx";
import { AppKeymapProvider, FieldShortcuts } from "./keymap/AppKeymap.tsx";
import { ShellContext } from "./ui/ModalShell.tsx";

/**
 * The providers an AIhub window needs, as aihub-code's panel host gives them
 * (app.tsx + PanelHost): AIhub's keymap, its bridge, its modal stack, and —
 * with `footer` (the default) — the footer-shaped shell, `height` rows tall.
 * aihub-code: AIhub's tree also had its SessionProvider and the ChatScreen;
 * the ported tests render one window, the way a panel does.
 */
export function HubTree({
  client,
  children,
  footer,
}: {
  client: HubBridge;
  children?: ReactNode;
  /** The panel's height in rows; omit for AIhub's own centred window. */
  footer?: number;
}) {
  // Tests never read the real system clipboard.
  const inner = (
    <>
      <FieldShortcuts read={async () => ""} hasImage={async () => false} />
      <ModalProvider>{children}</ModalProvider>
    </>
  );
  return (
    <BridgeProvider client={client}>
      <AppKeymapProvider>
        {footer === undefined ? (
          inner
        ) : (
          <ShellContext.Provider value={{ footer: true, height: footer }}>
            <box flexDirection="column" height={footer}>
              {inner}
            </box>
          </ShellContext.Provider>
        )}
      </AppKeymapProvider>
    </BridgeProvider>
  );
}

/** A window that can be closed and opened again (AIhub reopened it by its key). */
export interface Opened {
  setup: Awaited<ReturnType<typeof testRender>>;
  /** Times the window called its onClose (with what it passed). */
  closes: unknown[];
  isOpen(): boolean;
  reopen(): void;
}

/**
 * Render one AIhub window as aihub-code shows it: in the footer panel (all
 * rows but three: the gap, the status line and one row above), under `client`.
 */
export async function openWindow(
  client: unknown,
  render: (close: (value?: unknown) => void) => ReactNode,
  size: { width: number; height: number } = { width: 110, height: 34 },
  opts: { footer?: boolean } = {},
): Promise<Opened> {
  const closes: unknown[] = [];
  const ctl = { open: true, set: (_: boolean) => {} };
  function Harness() {
    const [open, setOpen] = useState(true);
    ctl.set = (v) => {
      ctl.open = v;
      setOpen(v);
    };
    return open ? (
      <>
        {render((value) => {
          closes.push(value);
          ctl.set(false);
        })}
      </>
    ) : null;
  }
  const setup = await testRender(
    <HubTree client={client as HubBridge} footer={opts.footer === false ? undefined : size.height - 3}>
      <Harness />
    </HubTree>,
    size,
  );
  return { setup, closes, isOpen: () => ctl.open, reopen: () => ctl.set(true) };
}

/** A bridge that answers startup calls and streams a scripted chat turn. */
export class MockBridge {
  script: Array<{ e: string; d: any }> = [];
  start() {}
  destroy() {}
  cancel() {}
  permission() {}
  async ready() {
    return { version: "0.3.15" };
  }
  async request(method: string): Promise<any> {
    switch (method) {
      case "config.get":
        return {
          project_dir: "",
          memory_enabled: true,
          tools_enabled: true,
          default_context_length: 4096,
          default_chat_model: "llama3.2:3b",
        };
      case "backend.status":
        return { ollama_online: true, llamacpp_online: false, llamacpp_model: "" };
      case "models.installed":
        return { models: [{ name: "llama3.2:3b", size_gb: 2 }], recent: [] };
      case "chat.start":
        return { messages: [{ role: "system", content: "sys" }] };
      default:
        return {};
    }
  }
  stream(method: string, params: any, handlers: any): { id: number; done: Promise<any> } {
    if (method === "chat.turn" && this.script.length) {
      const done = (async () => {
        await Promise.resolve();
        for (const ev of this.script) handlers.onEvent(ev.e, ev.d);
        return {
          messages: [...params.messages, { role: "assistant", content: "The host is localhost." }],
        };
      })();
      return { id: 42, done };
    }
    return { id: 1, done: Promise.resolve({ messages: [] }) };
  }
}

/** Wait until the frame matches; throws with the frame. */
export async function untilFrame(setup: Opened["setup"], pred: (f: string) => boolean, tries = 40): Promise<string> {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 40));
    await setup.flush();
    const f = setup.captureCharFrame();
    if (pred(f)) return f;
  }
  throw new Error("frame never matched:\n" + setup.captureCharFrame());
}
