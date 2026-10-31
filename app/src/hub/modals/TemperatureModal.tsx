// Ported from AIhub-TUI v1.5.0 app/src/modals/TemperatureModal.tsx.
/** @jsxImportSource ../jsx */
import { useState } from "react";
import { lift, theme, track } from "../theme.ts";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { useModalKeys } from "./modalKit.ts";

const PRESETS: Array<[string, number, string]> = [
  ["1", 0.2, "precise — code, facts, tools"],
  ["2", 0.7, "balanced — everyday chat"],
  ["3", 1.0, "creative — ideas, stories"],
];
const STEPS = 20; // 0.0 … 2.0 in 0.1 steps

/** What a temperature means, in words (also shown in Settings). */
export function temperatureLabel(t: number): string {
  return t <= 0.4 ? "precise and repeatable" : t <= 1.0 ? "balanced" : t <= 1.4 ? "creative" : "very random — may ramble";
}

/** How random the model's answers are. ←/→ by 0.1, 1–3 presets, enter saves. */
export function TemperatureModal({
  value,
  onSave,
  onClose,
}: {
  value: number;
  onSave: (t: number) => void;
  onClose: () => void;
}) {
  const [t, setT] = useState(Math.round(value * 10) / 10);
  const step = (d: number) => setT((v) => Math.max(0, Math.min(2, Math.round((v + d) * 10) / 10)));
  const save = (v = t) => {
    onSave(v);
    onClose();
  };
  useModalKeys([
    { key: "escape", run: onClose },
    { key: "left", run: () => step(-0.1) },
    { key: "right", run: () => step(0.1) },
    { key: "down", run: () => step(-0.1) },
    { key: "up", run: () => step(0.1) },
    { key: "return", run: () => save() },
    ...PRESETS.map(([k, v]) => ({ key: k, run: () => save(v) })),
  ]);

  const filled = Math.round(t * 10);
  const tone = t <= 0.4 ? theme.success : t <= 1.0 ? theme.accentSoft : theme.warn;
  const what = temperatureLabel(t);
  const width = useShellWidth(60);
  return (
    <ModalShell
      title="Temperature"
      width={width}
      height={13}
      hints={[
        ["←→", "adjust"],
        ["1-3", "preset"],
        ["enter", "save"],
      ]}
    >
      <box flexDirection="column" paddingTop={1}>
        <text>
          <span fg={theme.fg0}>{`  ${t.toFixed(1)}  `}</span>
          <span fg={tone}>{"━".repeat(filled)}</span>
          <span fg={track()}>{"━".repeat(STEPS - filled)}</span>
          <span fg={theme.fg2}>{`  ${what}`}</span>
        </text>
        <box marginTop={1} flexDirection="column">
          {PRESETS.map(([k, v, label]) => (
            <text key={k}>
              <span fg={theme.fg1} bg={theme.bg3} {...lift()}>{` ${k} `}</span>
              <span fg={Math.abs(v - t) < 0.05 ? theme.accent : theme.fg1}>{`  ${v.toFixed(1)}  `}</span>
              <span fg={theme.fg2}>{label}</span>
            </text>
          ))}
        </box>
        <text fg={theme.fg2}>{"  Saved as the default for new chats, too."}</text>
      </box>
    </ModalShell>
  );
}
