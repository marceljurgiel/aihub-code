// Ported from AIhub-TUI v1.5.0 app/src/ui/primitives.tsx.
import { useEffect, useState, type ReactNode } from "react";
import type { ColorInput } from "@opentui/core";
import { theme } from "../theme.ts";

// ── Micro-parts shared by every screen and modal ────────────────────────────

/** A keycap hint, e.g. [^O] or [enter]. */
export function KeyHint({ k }: { k: string }) {
  return (
    <span fg={theme.fg1} bg={theme.bg3}>{` ${k} `}</span>
  );
}

/** A small capability/status tag. */
export function Badge({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "accent" | "ok" | "warn" | "error";
}) {
  const map = {
    muted: theme.fg2,
    accent: theme.accentSoft,
    ok: theme.success,
    warn: theme.warn,
    error: theme.error,
  } as const;
  return <span fg={map[tone]}>{label}</span>;
}

/** Uppercase section micro-header with a trailing hairline. */
export function SectionLabel({ label, width }: { label: string; width: number }) {
  const rule = width - label.length - 4;
  return (
    <text>
      <span fg={theme.fg2}>{label.toUpperCase()}</span>
      <span fg={theme.border}>{" ".repeat(Math.max(1, rule))}·</span>
    </text>
  );
}

/** One selectable list row. Dense (h=1), selection = surface lift + marker. */
export function ListRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect?: () => void;
  children: ReactNode;
}) {
  return (
    <box
      flexDirection="row"
      backgroundColor={selected ? theme.bg3 : undefined}
      onMouseDown={onSelect}
    >
      <text>
        <span fg={selected ? theme.accent : theme.border}>{"▎"}</span>
      </text>
      {children}
    </box>
  );
}

/** Horizontal meter on one text line. */
export function Meter({
  fraction,
  width,
  color,
}: {
  fraction: number;
  width: number;
  color: ColorInput;
}) {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return (
    <text>
      <span fg={color}>{"━".repeat(filled)}</span>
      <span fg={theme.bg3}>{"━".repeat(width - filled)}</span>
    </text>
  );
}

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner; ticks only while mounted (modals unmount when closed). */
export function Spinner({ color = theme.accent }: { color?: ColorInput }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => v + 1), 80);
    return () => clearInterval(t);
  }, []);
  return <span fg={color}>{SPIN_FRAMES[i % SPIN_FRAMES.length]}</span>;
}

/** Footer hint strip: sequence of keycap + label pairs. */
/** Separators from roomiest to tightest: a narrow window gets a tighter bar
 *  rather than one that wraps onto a second line. */
const HINT_SEPS = ["  ·  ", " · ", "  "];

export function Hints({ items, width = Infinity }: { items: Array<[string, string]>; width?: number }) {
  const cells = items.reduce((n, [k, label]) => n + k.length + 2 + 1 + label.length, 0);
  const sep = HINT_SEPS.find((s) => cells + s.length * (items.length - 1) <= width) ?? HINT_SEPS.at(-1)!;
  return (
    <text>
      {items.map(([k, label], i) => (
        <span key={k}>
          <KeyHint k={k} />
          <span fg={theme.fg2}>{` ${label}`}</span>
          {i < items.length - 1 ? <span fg={theme.borderStrong}>{sep}</span> : null}
        </span>
      ))}
    </text>
  );
}
