// Ported from AIhub-TUI v1.5.0 app/src/jsx/jsx-dev-runtime.ts.
/** @opentui/react's dev JSX runtime, with console-safe text on Windows (glyphs.ts). */
import { Fragment, jsxDEV as baseJsxDEV } from "@opentui/react/jsx-dev-runtime";
import { safeProps } from "./safe.ts";

export type * from "@opentui/react/jsx-dev-runtime";
export { Fragment };

export function jsxDEV(type: any, props: any, key: any, isStatic: boolean, source?: any, self?: any) {
  return baseJsxDEV(type, safeProps(props), key, isStatic, source, self);
}
