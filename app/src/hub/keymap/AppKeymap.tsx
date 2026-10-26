// Ported from AIhub-TUI v1.5.0 app/src/keymap/AppKeymap.tsx.
import { useMemo, type ReactNode } from "react";
import { useRenderer } from "@opentui/react";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";

/**
 * Owns the app's single `Keymap` and hands it to `@opentui/keymap/react`.
 *
 * The keymap is built from `useRenderer()` rather than at module scope so the
 * same tree works under a real terminal renderer and under `testRender`'s
 * headless one. `createDefaultOpenTuiKeymap` brings the `enabled` and
 * `metadata` layer fields the layers below rely on.
 *
 * The keymap host *prepends* itself to the renderer's keypress listeners, so a
 * bound chord is seen before the focused input consumes it. That is what lets
 * Ctrl+O work while the user is mid-word in the chat box, and it is the
 * framework equivalent of Textual's `priority=True` bindings.
 *
 * aihub-code: AIhub's FieldShortcuts (Ctrl+V system paste, Ctrl+A select all
 * in every field) are not ported yet: they would also change the prompt box's
 * keys (Ctrl+A is line start there). A matched binding stops the key's
 * propagation, so the footer's own useKeyboard never sees it.
 */
export function AppKeymapProvider({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);
  return <KeymapProvider keymap={keymap}>{children}</KeymapProvider>;
}

/** Layer priorities. Higher wins; a modal must outrank everything. */
export const LAYER = {
  global: 10,
  nav: 20,
  input: 30,
  modal: 100,
  clipboard: 200,
} as const;
