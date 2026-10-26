// Ported from AIhub-TUI v1.5.0 app/src/modals/modalKit.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBindings } from "@opentui/keymap/react";
import { LAYER } from "../keymap/AppKeymap.tsx";

export type ModalKey = { key: string; run: () => void; label?: string };

/**
 * Register a modal-layer keymap. Modals render only while open, so the layer
 * exists exactly as long as the modal does — no enabled-gate needed.
 *
 * The keymap layer is memoised once, so its command closures would freeze at
 * the first render — the same trap ChatScreen solves with actionRef. Here the
 * layer dispatches through a ref into the *latest* handler array, so `up`
 * sees the current list length and `enter` sees the current query.
 */
export function useModalKeys(keys: ModalKey[], opts?: { enabled?: () => boolean }) {
  const latest = useRef(keys);
  latest.current = keys;
  const enabledRef = useRef(opts?.enabled);
  enabledRef.current = opts?.enabled;
  useBindings(
    () => ({
      priority: LAYER.modal,
      // Optional gate (evaluated at dispatch) — used to yield keys that double
      // as text (digits) while an input inside the modal has focus.
      enabled: () => enabledRef.current?.() ?? true,
      commands: keys.map((k) => ({
        name: `modal.${k.key}`,
        run: () => latest.current.find((x) => x.key === k.key)?.run(),
      })),
      bindings: keys.map((k) => ({ key: k.key, cmd: `modal.${k.key}` })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}

/** True when a text field owns the keyboard (shared with ChatScreen's nav gate). */
export function isTextInputFocused(renderer: { currentFocusedRenderable?: unknown }): boolean {
  const focused = renderer.currentFocusedRenderable as { constructor?: { name?: string } } | null;
  if (!focused) return false;
  const name = focused.constructor?.name ?? "";
  return name === "InputRenderable" || name === "TextareaRenderable";
}

/**
 * Windowed list navigation shared by every list modal. Returns the selected
 * index, a slice window [start, end) of `viewport` rows, and a jump helper.
 * Navigation is modal-layer driven: caller wires up/down/enter via useModalKeys.
 */
export function useWindowedList(count: number, viewport: number) {
  const [index, setIndex] = useState(0);
  const clamped = Math.max(0, Math.min(index, Math.max(0, count - 1)));
  const start = Math.max(0, Math.min(clamped - Math.floor(viewport / 2), Math.max(0, count - viewport)));
  const end = Math.min(count, start + viewport);

  const up = useCallback(
    () => setIndex((i) => (count ? (i - 1 + count) % count : 0)),
    [count],
  );
  const down = useCallback(
    () => setIndex((i) => (count ? (i + 1) % count : 0)),
    [count],
  );

  // Keep the selection valid when a filtered list shrinks.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, count - 1)));
  }, [count]);

  return { index: clamped, setIndex, up, down, start, end };
}

/** Subsequence fuzzy match: "gpt4" matches "GPT-4o mini". Returns score or -1. */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct; // substring beats scattered
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === ti ? 2 : 1; // consecutive chars score higher
    ti = found + 1;
  }
  return score;
}
