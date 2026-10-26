// Ported from AIhub-TUI v1.5.0 app/src/jsx/safe.ts.
/** Children text through consoleSafe (Windows) — the one place all rendered
 *  text passes, so no component has to remember it. */
import { SAFE_GLYPHS, consoleSafe } from "../glyphs.ts";

function fix(child: unknown): unknown {
  if (typeof child === "string") return consoleSafe(child);
  if (Array.isArray(child)) return child.map(fix);
  return child;
}

export function safeProps<P>(props: P): P {
  if (!SAFE_GLYPHS || !props || typeof props !== "object" || !("children" in props)) return props;
  const children = (props as { children?: unknown }).children;
  const fixed = fix(children);
  return fixed === children ? props : { ...props, children: fixed };
}
