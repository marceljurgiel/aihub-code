// Ported from AIhub-TUI v1.5.0 app/src/ui/primitives.tsx.
/** @jsxImportSource ../jsx */
import { Children, cloneElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { ColorInput } from "@opentui/core";
import { lift, theme, track } from "../theme.ts";

// ── Micro-parts shared by every screen and modal ────────────────────────────

/** A keycap hint, e.g. [^O] or [enter]. */
export function KeyHint({ k }: { k: string }) {
  return (
    <span fg={theme.fg1} bg={theme.bg3} {...lift()}>{` ${k} `}</span>
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
      {lifted(children, selected)}
    </box>
  );
}

/** aihub-code (R-T3-1): a selected row's text in reverse video where the
 *  theme's bg3 is see-through (see theme.lift); a child's own fg stays. */
export function lifted(children: ReactNode, on: boolean): ReactNode {
  const p = lift(on);
  if (!p.attributes) return children;
  return Children.map(children, (c) => {
    if (!isValidElement(c)) return c;
    const el = c as ReactElement<{ attributes?: number; fg?: ColorInput; bg?: ColorInput }>;
    return cloneElement(el, { attributes: (el.props.attributes ?? 0) | p.attributes!, fg: el.props.fg ?? p.fg, bg: p.bg });
  });
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
      <span fg={track()}>{"━".repeat(width - filled)}</span>
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
