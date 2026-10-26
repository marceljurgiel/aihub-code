// Ported from AIhub-TUI v1.5.0 app/src/ui/ModalShell.tsx.
import { createContext, useContext, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { SAFE_GLYPHS, consoleSafe } from "../glyphs.ts";
import { theme } from "../theme.ts";
import { Hints } from "./primitives.tsx";

/**
 * aihub-code: where the shell is drawn. In the line CLI a window is a panel in
 * the split footer (`footer: true`): it spans the terminal's width, is as tall
 * as the host says (`height`, whatever the window asked for) and has only top
 * and bottom borders, like the prompt box's place it takes.
 */
export const ShellContext = createContext<{ footer: boolean; height: number }>({ footer: false, height: 0 });

// aihub-code has no console-safe JSX runtime: the marker is swapped here.
const MARK = SAFE_GLYPHS ? consoleSafe("◆ ") : "◆ ";

/**
 * Shared modal frame: centered rounded panel with a title bar and a footer
 * hint strip. Every modal composes this, so the whole app has one modal
 * silhouette. Keyboard handling stays in each modal (they register a
 * LAYER.modal keymap); the shell only draws.
 */
export function ModalShell({
  title,
  width,
  height,
  hints = [],
  children,
}: {
  title: string;
  width: number;
  /** Total panel height including borders; omit to hug content. */
  height?: number;
  hints?: Array<[string, string]>;
  children: ReactNode;
}) {
  // A window never outgrows the terminal: a fixed height on a short screen
  // would push its bottom border and hints out of view.
  const term = useTerminalDimensions();
  const shell = useContext(ShellContext);
  width = Math.min(width, term.width);
  if (height !== undefined) height = Math.min(height, term.height);
  if (shell.footer) {
    width = term.width;
    height = shell.height;
  }
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      border={shell.footer ? ["top", "bottom"] : true}
      borderStyle="rounded"
      borderColor={theme.borderStrong}
      backgroundColor={theme.bg1}
    >
      {/* title bar */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <text>
          <span fg={theme.accent}>{MARK}</span>
          <span fg={theme.fg0}>{title}</span>
        </text>
        <text fg={theme.fg2}>esc close</text>
      </box>
      <box flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme.borderStrong}>{"─".repeat(width - 4)}</text>
      </box>

      {/* body — clipped, so content that doesn't fit can never paint over
          the hint bar or outside the frame */}
      <box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" paddingLeft={1} paddingRight={1}>
        {/* Never shrinks below its content: on a short terminal rows are cut
            at the bottom instead of being squeezed onto each other. */}
        <box flexDirection="column" flexGrow={1} flexShrink={0}>
          {children}
        </box>
      </box>

      {/* footer hints */}
      {hints.length ? (
        <box flexShrink={0} paddingLeft={1} paddingRight={1}>
          <Hints items={hints} width={width - 4} />
        </box>
      ) : null}
    </box>
  );
}
