// Ported from AIhub-TUI v1.5.0 app/src/modals/HelpModal.tsx.
/** @jsxImportSource ../jsx */
import { useTerminalDimensions } from "@opentui/react";
import { theme, fit } from "../theme.ts";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { SectionLabel } from "../ui/primitives.tsx";
import { ACTIONS, shortKey } from "../keymap/actions.ts";
import { SLASH_COMMANDS } from "../slash.ts";
import { useModalKeys } from "./modalKit.ts";

/** aihub-code: the line CLI's own keys and its code-mode commands, shown
 *  where AIhub shows its sidebar's quick nav (there is no sidebar here). */
const CODE_KEYS: Array<[string, string]> = [
  ["S-Tab", "mode: build → auto → plan"],
  ["Esc", "interrupt the turn; close a window"],
  ["^C ^C", "exit (one ^C interrupts or clears)"],
  ["^D", "exit (empty prompt)"],
  ["^J", "new line in the prompt"],
  ["↑↓", "earlier prompts"],
];
const CODE_COMMANDS: Array<[string, string]> = [
  ["/undo", "undo the last turn's file changes"],
  ["/rules", "permission rules; /rules remove N"],
  ["/compact", "summarize to free context"],
  ["/todos", "the model's todo list"],
  ["/sessions", "earlier sessions of this folder"],
  ["/resume", "resume one → /resume <id>"],
  ["/mode", "show or change the mode"],
  ["/context", "how much context is used"],
];
const WINDOWS = "/models /hardware /settings /theme";

/** Reference card generated from the live action table + slash registry. */
export function HelpModal({ onClose }: { onClose: () => void }) {
  useModalKeys([{ key: "escape", run: onClose }]);
  const width = useShellWidth(78);
  const chords = ACTIONS.filter((a) => a.key);
  const slash = SLASH_COMMANDS;
  // Two chords per row keeps the left column shorter than the slash list.
  const pairs = chords.reduce<Array<typeof chords>>(
    (rows, a, i) => (i % 2 ? (rows[rows.length - 1]!.push(a), rows) : [...rows, [a]]),
    [],
  );
  const { height: termH } = useTerminalDimensions();
  const left = pairs.length + CODE_KEYS.length + CODE_COMMANDS.length + 6;
  // Shell 5 + top padding 1 + header 1 + the longer column; never taller than the screen.
  const height = Math.min(7 + Math.max(slash.length, left), termH);
  const half = Math.floor(width / 2) - 1;
  const right = Math.ceil(width / 2) - 1;

  return (
    <ModalShell title="Help" width={width} height={height} hints={[["esc", "close"]]}>
      <box flexDirection="row" flexGrow={1} paddingTop={1}>
        <box flexDirection="column" width={half}>
          <SectionLabel label="keys" width={half - 1} />
          {pairs.map((pair) => (
            <text key={pair[0]!.id} flexShrink={0}>
              {pair.map((a) => (
                <span key={a.id}>
                  <span fg={theme.fg2}>{`  ${shortKey(a.key!).padEnd(7)}`}</span>
                  <span fg={theme.fg1}>{fit(a.label, 12).padEnd(12)}</span>
                </span>
              ))}
            </text>
          ))}
          {CODE_KEYS.map(([k, label]) => (
            <text key={k} flexShrink={0}>
              <span fg={theme.fg2}>{`  ${k.padEnd(7)}`}</span>
              <span fg={theme.fg1}>{fit(label, half - 10)}</span>
            </text>
          ))}
          <box marginTop={1} flexDirection="column" flexShrink={0}>
            <SectionLabel label="code mode" width={half - 1} />
            {CODE_COMMANDS.map(([c, desc]) => (
              <text key={c} flexShrink={0}>
                <span fg={theme.accentSoft}>{`  ${c.padEnd(10)}`}</span>
                <span fg={theme.fg2}>{fit(desc, half - 13)}</span>
              </text>
            ))}
            <text flexShrink={0}>
              <span fg={theme.fg2}>{"  windows: "}</span>
              <span fg={theme.accentSoft}>{fit(WINDOWS, half - 13)}</span>
            </text>
          </box>
        </box>

        <box flexDirection="column" width={right}>
          <SectionLabel label="slash commands" width={right - 1} />
          {slash.map((c) => (
            <text key={c.cmd} flexShrink={0}>
              <span fg={theme.accentSoft}>{`  ${fit(c.cmd, 14).padEnd(15)}`}</span>
              <span fg={theme.fg2}>{fit(c.desc, Math.max(20, right - 18))}</span>
            </text>
          ))}
        </box>
      </box>
    </ModalShell>
  );
}
