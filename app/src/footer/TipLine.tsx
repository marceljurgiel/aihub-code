/**
 * The "Did you know?" row above the prompt: the prefix at once, the sentence
 * typed out a character at a time (quickly: well under a second).
 */
import { useEffect, useState } from "react";
import { palette } from "../theme";
import { TIP_PREFIX } from "../tips";
import { truncate } from "../width";
import { LineText } from "./LineText";

export const TIP_TYPE_MS = 14;

export function TipLine({ tip, width, typeMs = TIP_TYPE_MS }: { tip: string; width: number; typeMs?: number }) {
  const [shown, setShown] = useState(typeMs > 0 ? 0 : tip.length);
  useEffect(() => {
    if (shown >= tip.length) return;
    const t = setTimeout(() => setShown((n) => Math.min(tip.length, n + 1)), typeMs);
    return () => clearTimeout(t);
  }, [shown, tip, typeMs]);
  const room = Math.max(0, width - 1 - TIP_PREFIX.length);
  return (
    <box height={1} flexShrink={0}>
      <LineText
        line={[
          { text: " " },
          { text: TIP_PREFIX, fg: palette.accent, bold: true },
          { text: truncate(tip.slice(0, shown), room), dim: true },
        ]}
      />
    </box>
  );
}
