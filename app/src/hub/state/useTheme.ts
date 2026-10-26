// Ported from AIhub-TUI v1.5.0 app/src/state/useTheme.ts.
import { useSyncExternalStore } from "react";
import { subscribeTheme, themeVersion } from "../theme.ts";

/**
 * Re-render when the theme changes. Components read `theme.x` while
 * rendering, so the screen root, the modal host and every memo()'d component
 * call this; everything else re-renders with its parent.
 */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribeTheme, themeVersion, themeVersion);
}
