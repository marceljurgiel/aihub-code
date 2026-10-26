// Ported from AIhub-TUI v1.5.0 app/src/modals/HistoryModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useState } from "react";
import { theme, fit } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { ListRow } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList } from "./modalKit.ts";
import type { ChatMessage } from "../bridge/types.ts";

interface SessionRow {
  filename: string;
  start_time?: string;
  end_time?: string;
  message_count?: number;
  temperature?: number;
}

const VIEWPORT = 12;

/** Past sessions for the current model: enter resumes, d deletes. */
export function HistoryModal({
  model,
  onLoad,
  onClose,
}: {
  model: string | null;
  /** startTime: the session's own start, so autosave keeps updating its file. */
  onLoad: (messages: ChatMessage[], startTime?: string) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const list = useWindowedList(sessions.length, VIEWPORT);

  const refresh = () => {
    setLoading(true);
    if (!model) {
      setSessions([]);
      setLoading(false);
      return;
    }
    bridge
      .request("history.list", { model })
      .then((d) => setSessions(d.sessions || []))
      .catch((e) => setNote(String((e as Error).message || e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [model]);

  const resume = () => {
    const s = sessions[list.index];
    if (!s) return;
    bridge
      .request("history.load", { model, filename: s.filename })
      .then((d) => {
        const msgs: ChatMessage[] = d.messages || [];
        if (!msgs.length) {
          setNote("Session file has no messages.");
          return;
        }
        onLoad(msgs, d.start_time);
        onClose();
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const del = () => {
    const s = sessions[list.index];
    if (!s) return;
    if (armed !== s.filename) {
      setArmed(s.filename);
      setNote("Press d again to delete permanently.");
      return;
    }
    bridge
      .request("history.delete", { model, filename: s.filename })
      .then(() => {
        setArmed(null);
        setNote("");
        refresh();
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  useModalKeys([
    { key: "escape", run: onClose },
    { key: "up", run: list.up },
    { key: "down", run: list.down },
    { key: "return", run: resume },
    { key: "d", run: del },
    { key: "r", run: refresh },
  ]);

  const width = useShellWidth(78);
  return (
    <ModalShell
      title={`History — ${model ?? "no model"}`}
      width={width}
      height={VIEWPORT + 7}
      hints={[
        ["↑↓", "select"],
        ["enter", "resume"],
        ["d", "delete"],
        ["r", "refresh"],
      ]}
    >
      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        {loading ? (
          <text fg={theme.fg2}>{"  loading…"}</text>
        ) : sessions.length === 0 ? (
          <text fg={theme.fg2}>{"  No saved sessions for this model yet."}</text>
        ) : (
          sessions.slice(list.start, list.end).map((s, i) => {
            const idx = list.start + i;
            const selected = idx === list.index;
            const when = (s.start_time || "").replace("T", " ").slice(0, 16);
            return (
              <ListRow key={s.filename} selected={selected} onSelect={() => list.setIndex(idx)}>
                <text>
                  <span fg={selected ? theme.fg0 : theme.fg1}>{` ${when || "?"}`}</span>
                  <span fg={theme.fg2}>{`  ${s.message_count ?? "?"} msgs`}</span>
                  {armed === s.filename ? <span fg={theme.error}>{"  ⨯ delete?"}</span> : null}
                </text>
              </ListRow>
            );
          })
        )}
      </box>

      {note ? (
        <box flexShrink={0}>
          <text fg={theme.warn}>{fit(note, width - 6)}</text>
        </box>
      ) : null}
    </ModalShell>
  );
}
