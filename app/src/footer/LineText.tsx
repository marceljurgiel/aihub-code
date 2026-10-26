/**
 * A styled line as a <text>, drawn exactly like the transcript draws it
 * (same colours, same default foreground), so the footer matches the scrollback
 * and uses the terminal's own colours.
 */
import { StyledText } from "@opentui/core";
import type { Line } from "../scrollback";
import { spanChunk } from "../scrollback";

export function LineText({ line }: { line: Line }) {
  if (line.length === 0 || line.every((s) => s.text === "")) return <box height={1} flexShrink={0} />;
  return <text content={new StyledText(line.map(spanChunk))} wrapMode="none" flexShrink={0} />;
}
