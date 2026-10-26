/**
 * Draws the open AIhub window (a `controller.panel`) inside the split footer,
 * in place of the prompt box. The window is AIhub's own component (hub/),
 * drawn in the footer-shaped ModalShell (ShellContext): full width, `rows`
 * tall, top and bottom borders only. Its keys are its own keymap layer; its
 * close (Esc) closes the panel.
 *
 * The hub's providers (AppKeymapProvider, BridgeProvider) sit at the app's
 * root (app.tsx), so a window keeps them across re-renders of the footer.
 */
import { useThemeVersion } from "../hub/state/useTheme";
import { MemoryModal } from "../hub/modals/MemoryModal";
import { useModalKeys } from "../hub/modals/modalKit";
import { ModalShell, ShellContext } from "../hub/ui/ModalShell";
import { theme } from "../hub/theme";
import type { Controller, PanelId } from "../session/controller";
import { useController } from "../session/useController";

export interface PanelHostProps {
  controller: Controller;
  /** Terminal width in columns. */
  width: number;
  /** The panel's height in rows. */
  rows: number;
}

export function PanelHost({ controller, width, rows }: PanelHostProps) {
  useThemeVersion();
  const { panel } = useController(controller);
  if (!panel) return null;
  const close = (result?: string) => controller.closePanel(result);
  return (
    <ShellContext.Provider value={{ footer: true, height: rows }}>
      <box width={width} height={rows} flexShrink={0} flexDirection="column">
        {panel.id === "memory" ? <MemoryModal onClose={() => close()} /> : <NotYet id={panel.id} onClose={() => close()} />}
      </box>
    </ShellContext.Provider>
  );
}

/** A window that hasn't been brought over yet (the spike ports Memory only). */
function NotYet({ id, onClose }: { id: PanelId; onClose: () => void }) {
  useModalKeys([{ key: "escape", run: onClose }]);
  return (
    <ModalShell title={id} width={60} hints={[["esc", "close"]]}>
      <text fg={theme.fg2}>This window isn't in aihub-code yet.</text>
    </ModalShell>
  );
}
