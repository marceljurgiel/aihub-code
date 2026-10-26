/** @jsxImportSource ../hub/jsx */
/**
 * Draws the open AIhub window (a `controller.panel`) inside the split footer,
 * in place of the prompt box. The window is AIhub's own component (hub/),
 * built by the registry and drawn in the footer-shaped ModalShell
 * (ShellContext): full width, `rows` tall, top and bottom borders only. Its
 * keys are its own keymap layer; its close (Esc) closes the panel.
 *
 * A window that opens another (Settings → Temperature, Models → a download)
 * does it through AIhub's ModalProvider, which in the footer shows the top one
 * in the panel's place.
 *
 * The hub's providers (AppKeymapProvider, BridgeProvider) sit at the app's
 * root (app.tsx), so a window keeps them across re-renders of the footer.
 * AIhub's field shortcuts (Ctrl+V system paste, Ctrl+A select all) live only
 * while a window is open: the prompt box keeps its own keys.
 */
import { FieldShortcuts } from "../hub/keymap/AppKeymap";
import { useThemeVersion } from "../hub/state/useTheme";
import { ModalProvider } from "../hub/state/ModalContext";
import { ShellContext } from "../hub/ui/ModalShell";
import type { Controller } from "../session/controller";
import { useController } from "../session/useController";
import { panelFactory } from "./registry";
import { toSessionLike } from "./session-adapter";

export interface PanelHostProps {
  controller: Controller;
  /** Terminal width in columns. */
  width: number;
  /** The panel's height in rows. */
  rows: number;
}

export function PanelHost({ controller, width, rows }: PanelHostProps) {
  useThemeVersion();
  const st = useController(controller);
  const { panel } = st;
  if (!panel) return null;
  const render = panelFactory(panel.id, { controller, session: toSessionLike(st), arg: panel.arg });
  return (
    <ShellContext.Provider value={{ footer: true, height: rows, width }}>
      <box width={width} height={rows} flexShrink={0} flexDirection="column">
        <FieldShortcuts />
        {/* A new window (palette → models) starts with its own state. */}
        <ModalProvider key={panel.id}>{render((result) => controller.closePanel(result))}</ModalProvider>
      </box>
    </ShellContext.Provider>
  );
}
