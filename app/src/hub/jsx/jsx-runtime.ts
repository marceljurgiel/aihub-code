// Ported from AIhub-TUI v1.5.0 app/src/jsx/jsx-runtime.ts.
/** @opentui/react's JSX runtime, with console-safe text on Windows (glyphs.ts). */
import { Fragment, jsx as baseJsx, jsxs as baseJsxs } from "@opentui/react/jsx-runtime";
import { safeProps } from "./safe.ts";

export type * from "@opentui/react/jsx-runtime";
export { Fragment };

export function jsx(type: any, props: any, key?: any) {
  return baseJsx(type, safeProps(props), key);
}

export function jsxs(type: any, props: any, key?: any) {
  return baseJsxs(type, safeProps(props), key);
}
