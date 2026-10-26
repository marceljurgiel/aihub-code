// Ported from AIhub-TUI v1.5.0 app/src/modals/PaletteModal.tsx.
/** @jsxImportSource ../jsx */
import { useMemo, useState } from "react";
import { singleLinePaste } from "../clipboard.ts";
import { theme, fit, lift } from "../theme.ts";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { ACTIONS, shortKey, type ActionId } from "../keymap/actions.ts";
import { useModalKeys, useWindowedList, fuzzyScore } from "./modalKit.ts";

const VIEWPORT = 10;

/** Fuzzy launcher over the shared action table — the same entries the sidebar
 *  and keymap read, so the palette can never offer a stale action. */
export function PaletteModal({
  onAction,
  onClose,
}: {
  onAction: (id: ActionId) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const width = useShellWidth(60);

  const rows = useMemo(() => {
    const q = query.trim();
    return ACTIONS.map((a) => ({ spec: a, score: fuzzyScore(q, a.label) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score);
  }, [query]);

  const list = useWindowedList(rows.length, VIEWPORT);

  const run = () => {
    const row = rows[list.index];
    if (!row) return;
    onClose();
    onAction(row.spec.id);
  };

  useModalKeys([
    { key: "escape", run: onClose },
    { key: "up", run: list.up },
    { key: "down", run: list.down },
    { key: "return", run: run },
  ]);

  return (
    <ModalShell
      title="Command palette"
      width={width}
      height={VIEWPORT + 8}
      hints={[["↑↓", "select"], ["enter", "run"]]}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.bg2}
        flexShrink={0}
        paddingLeft={1}
      >
        <input
          onPaste={singleLinePaste}
          value={query}
          onInput={(v: string) => setQuery(v)}
          focused
          placeholder="type a command…"
          backgroundColor={theme.bg2}
          textColor={theme.fg0}
          placeholderColor={theme.fg2}
          cursorColor={theme.accent}
        />
      </box>

      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        {rows.slice(list.start, list.end).map((row, i) => {
          const idx = list.start + i;
          const selected = idx === list.index;
          return (
            <box
              key={row.spec.id}
              backgroundColor={selected ? theme.bg3 : undefined}
              onMouseDown={() => list.setIndex(idx)}
            >
              <text attributes={lift(selected)}>
                <span fg={selected ? theme.accent : theme.border}>{"▎"}</span>
                <span fg={selected ? theme.fg0 : theme.fg1}>{` ${fit(row.spec.label, 30)}`}</span>
                {row.spec.key ? (
                  <span fg={selected ? theme.accentSoft : theme.fg2}>{`  ${shortKey(row.spec.key)}`}</span>
                ) : null}
              </text>
            </box>
          );
        })}
        {rows.length === 0 ? <text fg={theme.fg2}>{`  no matching command`}</text> : null}
      </box>
    </ModalShell>
  );
}
