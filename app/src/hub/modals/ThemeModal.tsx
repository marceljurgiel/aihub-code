// Ported from AIhub-TUI v1.5.0 app/src/modals/ThemeModal.tsx.
/** @jsxImportSource ../jsx */
import { useRef, useState } from "react";
import { ACCENTS, THEMES, activeTheme, applyTheme, lift, theme } from "../theme.ts";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { useModalKeys } from "./modalKit.ts";

const THEME_IDS = Object.keys(THEMES);
/** "" first: the theme's own accent. */
const ACCENT_IDS = ["", ...Object.keys(ACCENTS)];

/**
 * Colour theme + accent. ↑↓ picks a theme, ←→ an accent; both apply live so
 * the whole app is the preview. Enter keeps it (saved), Esc puts back what
 * was there.
 */
export function ThemeModal({
  onSave,
  onClose,
}: {
  onSave: (name: string, accent: string) => void;
  onClose: () => void;
}) {
  const original = useRef({ ...activeTheme });
  const [name, setName] = useState(activeTheme.name);
  const [accent, setAccent] = useState(activeTheme.accent);

  const pick = (n: string, a: string) => {
    setName(n);
    setAccent(a);
    applyTheme(n, a);
  };
  // From the live theme, not the state: keys can arrive faster than renders
  // (a held arrow), and a stale closure would skip steps.
  const moveTheme = (d: number) => {
    const i = THEME_IDS.indexOf(activeTheme.name);
    pick(THEME_IDS[(i + d + THEME_IDS.length) % THEME_IDS.length]!, activeTheme.accent);
  };
  const moveAccent = (d: number) => {
    const i = ACCENT_IDS.indexOf(activeTheme.accent);
    pick(activeTheme.name, ACCENT_IDS[(i + d + ACCENT_IDS.length) % ACCENT_IDS.length]!);
  };
  const cancel = () => {
    applyTheme(original.current.name, original.current.accent);
    onClose();
  };

  useModalKeys([
    { key: "escape", run: cancel },
    { key: "up", run: () => moveTheme(-1) },
    { key: "down", run: () => moveTheme(1) },
    { key: "left", run: () => moveAccent(-1) },
    { key: "right", run: () => moveAccent(1) },
    {
      key: "return",
      run: () => {
        onSave(activeTheme.name, activeTheme.accent);
        onClose();
      },
    },
  ]);

  const width = useShellWidth(64);
  return (
    <ModalShell
      title="Theme"
      width={width}
      height={THEME_IDS.length + 12}
      hints={[
        ["↑↓", "theme"],
        ["←→", "accent"],
        ["enter", "keep"],
        ["esc", "cancel"],
      ]}
    >
      <box flexDirection="column" paddingTop={1}>
        {THEME_IDS.map((id) => {
          const t = THEMES[id]!;
          const p = t.palette;
          const on = id === name;
          return (
            <box key={id} flexDirection="row" backgroundColor={on ? theme.bg3 : undefined}>
              <text>
                <span fg={on ? theme.accent : theme.border}>{"▌ "}</span>
                <span fg={on ? theme.fg0 : theme.fg1} attributes={lift(on)}>{t.label.padEnd(16)}</span>
                {/* The theme's own colours: surfaces, text, accent, status. */}
                <span fg={p.bg1}>{"██"}</span>
                <span fg={p.bg3}>{"██"}</span>
                <span fg={p.fg0}>{"██"}</span>
                <span fg={p.accent}>{"██"}</span>
                <span fg={p.accentSoft}>{"██"}</span>
                <span fg={p.success}>{"██"}</span>
                <span fg={p.warn}>{"██"}</span>
                <span fg={p.error}>{"██"}</span>
              </text>
            </box>
          );
        })}
        <box marginTop={1} flexDirection="column">
          <text fg={theme.fg2}>{"  accent"}</text>
          {[ACCENT_IDS.slice(0, 5), ACCENT_IDS.slice(5)].map((row, r) => (
            <text key={r}>
              {"  "}
              {row.map((id) => {
                const on = id === accent;
                const color = id ? ACCENTS[id]!.accent : THEMES[name]!.palette.accent;
                return (
                  <span key={id || "own"} fg={on ? theme.fg0 : theme.fg2} bg={on ? theme.bg3 : undefined}>
                    <span fg={color}>{" ■"}</span>
                    <span attributes={lift(on)}>{` ${(id ? ACCENTS[id]!.label : "Theme's").padEnd(8)}`}</span>
                  </span>
                );
              })}
            </text>
          ))}
        </box>
      </box>
    </ModalShell>
  );
}
