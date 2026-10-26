// Ported from AIhub-TUI v1.5.0 app/src/modals/MemoryModal.tsx.
import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import { theme, fit } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell } from "../ui/ModalShell.tsx";
import { useModalKeys } from "./modalKit.ts";

/** Long-term memory: the Markdown file the engine injects into every chat
 *  ("## Topic" + fact; the model's `remember` tool writes the same format).
 *  Edit in place; ^S saves, ^X clears (twice to confirm).
 *
 *  The textarea has no `value` property: its text is set with setText() and
 *  read from plainText. (Assigning `.value` used to leave the editor blank,
 *  and saving then wrote back the old text, dropping every edit.) */
export function MemoryModal({ onClose }: { onClose: () => void }) {
  const bridge = useBridge();
  const [loaded, setLoaded] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [status, setStatus] = useState("loading…");
  const [armed, setArmed] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  const el = useRef<TextareaRenderable | null>(null);
  // Text we put into the editor ourselves: its content-change echo must not
  // clear the status ("Memory cleared.") or disarm a pending ^X.
  const programmatic = useRef<string | null>(null);
  const setEditor = (v: string) => {
    programmatic.current = v;
    el.current?.setText(v);
  };
  // As tall as the terminal allows: memory grows as AIhub learns, and facts
  // below the fold of a fixed 20-row window looked like they weren't saved.
  const { width: termW, height: termH } = useTerminalDimensions();
  const height = Math.max(16, Math.min(termH - 4, 44));
  const width = Math.max(60, Math.min(termW - 8, 96));

  useEffect(() => {
    bridge
      .request("memory.load")
      .then((d) => {
        const content = d.content || "";
        setLoaded(content);
        setText(content);
        setSaved(content);
        setStatus(content ? "" : "Memory is empty — add facts as “## Topic” + a line below it.");
      })
      .catch((e) => setStatus(`load failed: ${(e as Error).message}`));
  }, []);

  // Push the loaded text into the editor once both exist.
  useEffect(() => {
    if (loaded != null && el.current) setEditor(loaded);
  }, [loaded]);

  const current = () => (el.current ? el.current.plainText : text);
  const dirty = text !== saved;

  const save = () => {
    if (loaded == null) return;                  // never save before the load
    const content = current();
    bridge
      .request("memory.save", { content })
      .then(() => {
        setSaved(content);
        setText(content);
        setDiscardArmed(false);
        setStatus("Memory saved.");
      })
      .catch((e) => setStatus(`save failed: ${(e as Error).message}`));
  };

  const clear = () => {
    if (!armed) {
      setArmed(true);
      setStatus("Press ^X again to wipe all memory.");
      return;
    }
    bridge
      .request("memory.clear")
      .then(() => {
        setEditor("");
        setText("");
        setSaved("");
        setArmed(false);
        setStatus("Memory cleared.");
      })
      .catch((e) => setStatus(`clear failed: ${(e as Error).message}`));
  };

  const close = () => {
    if (dirty && !discardArmed) {
      setDiscardArmed(true);
      setStatus("Unsaved changes — ^S to save, Esc again to discard.");
      return;
    }
    onClose();
  };

  // Ctrl chords only: bare letters belong to the text being typed (a bare
  // "x" twice used to wipe memory mid-word).
  useModalKeys([
    { key: "escape", run: close },
    { key: "ctrl+s", run: save },
    { key: "ctrl+x", run: clear },
  ]);

  const tone = status.startsWith("Unsaved") || status.startsWith("Press") || status.includes("failed")
    ? theme.warn
    : theme.fg2;
  return (
    <ModalShell
      title="Memory"
      width={width}
      height={height}
      hints={[
        ["^S", "save"],
        ["^X", "clear"],
        ["esc", "close"],
      ]}
    >
      <box
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.bg2}
        marginTop={1}
        marginBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <textarea
          ref={el}
          onContentChange={() => {
            const now = current();
            setText(now);
            if (now === programmatic.current) return;   // our own setText
            programmatic.current = null;
            setArmed(false);
            setDiscardArmed(false);
            setStatus("");
          }}
          focused
          backgroundColor={theme.bg2}
          textColor={theme.fg0}
          placeholderColor={theme.fg2}
          cursorColor={theme.accent}
          placeholder={"## Topic\nA fact to remember, e.g. favourite editor or your servers"}
        />
      </box>
      <box flexShrink={0}>
        <text fg={tone}>
          {fit(
            status || `${text.split("\n").length} lines · ${text.length} chars${dirty ? " · unsaved" : ""}`,
            width - 6,
          )}
        </text>
      </box>
    </ModalShell>
  );
}
