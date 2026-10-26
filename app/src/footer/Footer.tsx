/**
 * The live footer of the line CLI (split-footer): activity line, then the input
 * box, the permission prompt or a picker (one of them), slash suggestions and
 * the status line. Its height is computed from what it shows and reported
 * through `onHeight`; the renderer's footer is resized to match.
 *
 * Keys: while the prompt is showing, this component owns them (so a turn that
 * runs never turns typing into shortcuts): Enter sends (or queues), Shift+Tab
 * cycles the mode, Ctrl+P opens the palette, Esc / Ctrl+C / Ctrl+D as the spec says, Up/Down walk the
 * history only from the first/last row. The permission prompt and the picker
 * handle their own keys.
 *
 * An open AIhub window (`panel`) takes the box's place and almost the whole
 * terminal (all rows but one); its keys are its own keymap layer (Ctrl+C there
 * does what the window's Esc does), and this component ignores every key
 * meanwhile.
 */
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Controller } from "../session/controller";
import { useController } from "../session/useController";
import { sanitize } from "../width";
import { PanelHost } from "../panels/PanelHost";
import { ActivityLine } from "./ActivityLine";
import { CONFIRM_ROWS, ConfirmPrompt } from "./ConfirmPrompt";
import { PermissionPrompt, permissionLayout } from "./PermissionPrompt";
import { Picker, pickerInnerRows } from "./Picker";
import { MAX_INPUT_ROWS, PromptBox } from "./PromptBox";
import { SlashSuggest, MAX_SUGGESTIONS, slashMatches, type SlashCommand } from "./SlashSuggest";
import { StatusLine, type StatusInput } from "./StatusLine";

export interface FooterProps {
  controller: Controller;
  /** Terminal width in columns. */
  width: number;
  /** The footer's height in rows whenever it changes. */
  onHeight?: (rows: number) => void;
  /** A sent prompt (Enter). Task 7 routes /commands here; the default queues it. */
  onSubmit?: (text: string) => void;
  commands?: readonly SlashCommand[];
  /** The most rows the footer may take: a short terminal keeps room for the
   *  transcript. Suggestions, input rows, picker rows and diff rows give way. */
  maxHeight?: number;
  /** The terminal's rows: an open panel makes the footer all but one of them. */
  rows?: number;
  /** Earlier prompts, oldest first (a resumed session's, for Up). */
  history?: readonly string[];
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  /** Ignore picker / question keys this long after one appears. */
  guardMs?: number;
  /** The permission prompt counts a key only after this much quiet (every
   *  key restarts it): a follow-up being typed can't answer it. */
  permissionQuietMs?: number;
  /** How long "Press Ctrl+C again to exit" stays. */
  ctrlCWindowMs?: number;
}

const HISTORY_MAX = 200;
export const PERMISSION_QUIET_MS = 500;
const HINTS = {
  permission: "↑↓ choose · enter confirm · esc no",
  note: "enter send · esc back",
  confirm: "y yes · n no · esc no",
  picker: "↑↓ choose · enter select · esc cancel",
  panel: "esc close",
};
/** Without `rows` (tests of other things): a classic 24-row terminal. */
const DEFAULT_ROWS = 24;

export function Footer(props: FooterProps) {
  const { controller, width, onHeight, commands = [], maxHeight, now = Date.now, guardMs = 250, permissionQuietMs = PERMISSION_QUIET_MS, ctrlCWindowMs = 2000 } = props;
  const st = useController(controller);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const [rows, setRows] = useState(1);
  const total = useRef(1); // wrapped rows of the whole text, not clamped
  const [typed, setTyped] = useState("");
  const lastText = useRef(""); // what the box holds: it is restored when the box comes back
  const draft = useRef(""); // what was typed before Up started walking the history
  const [hi, setHi] = useState(0);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const interruptedRef = useRef(false);
  const history = useRef<string[]>([...(props.history ?? [])]);
  const typedHere = useRef<string[]>([]); // prompts sent from this footer, kept when `history` is replaced
  const pos = useRef(-1); // -1: not walking the history
  const [, tick] = useState(0);
  const [noting, setNoting] = useState(false); // the permission prompt's inline input is open

  // A resumed session's prompts arrive after the footer is up: they go first,
  // what was typed here since stays after them.
  useEffect(() => {
    history.current = [...(props.history ?? []), ...typedHere.current].slice(-HISTORY_MAX);
    pos.current = -1;
  }, [props.history]);

  const asking = st.phase === "permission" && st.permission !== null;
  const picking = st.picker !== null;
  // A permission prompt or a picker can't start while a panel is open
  // (openPanel refuses then); if one ever did, it comes first.
  const paneled = st.panel !== null && !asking && !picking;
  const confirming = st.confirm !== null && !asking && !picking && !paneled;
  const prompting = !asking && !picking && !confirming && !paneled;
  const running = st.phase === "running" || st.phase === "permission";
  const matches = prompting ? slashMatches(typed, commands) : [];
  const hiNow = Math.min(hi, Math.max(0, matches.length - 1));

  // Everything a key handler reads lives here: keys can outrun renders.
  const live = useRef({ st, prompting, running, matches, hi: hiNow, width });
  live.current = { st, prompting, running, matches, hi: hiNow, width };

  // ── the input ────────────────────────────────────────────────────────────

  /** Re-read the textarea: its wrapped rows (the footer's height) and its text. */
  const sync = () => {
    const ta = inputRef.current;
    if (!ta) return;
    const w = Math.max(1, live.current.width - 6);
    const n = Math.max(1, ta.editorView.measureForDimensions(w, 10_000)?.lineCount ?? 1);
    total.current = n;
    setRows(Math.min(MAX_INPUT_ROWS, n));
    const text = ta.plainText;
    lastText.current = text;
    setTyped((t) => (t === text ? t : text));
  };
  useLayoutEffect(sync, [width, prompting]);

  const setInput = (text: string) => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.setText(text);
    ta.gotoBufferEnd();
    sync();
  };

  // ── ticking, interrupted flag, timers ────────────────────────────────────

  const hasActivity = st.activity !== null;
  useEffect(() => {
    if (!hasActivity) return;
    const id = setInterval(() => tick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [hasActivity]);

  useEffect(() => {
    if (!running) {
      interruptedRef.current = false;
      setInterrupted(false);
    }
  }, [running]);

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  const disarm = () => {
    if (!armedRef.current) return;
    armedRef.current = false;
    setArmed(false);
    if (armTimer.current) clearTimeout(armTimer.current);
  };
  const arm = () => {
    armedRef.current = true;
    setArmed(true);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => {
      armedRef.current = false;
      setArmed(false);
    }, ctrlCWindowMs);
  };

  const interrupt = () => {
    controller.cancel();
    interruptedRef.current = true;
    setInterrupted(true);
  };

  // ── actions ──────────────────────────────────────────────────────────────

  const send = () => {
    const ta = inputRef.current;
    if (!ta) return;
    const text = ta.plainText.trim();
    if (text === "") return;
    const h = history.current;
    if (h[h.length - 1] !== text) {
      h.push(text);
      typedHere.current.push(text);
    }
    if (h.length > HISTORY_MAX) h.shift();
    pos.current = -1;
    ta.setText("");
    sync();
    (props.onSubmit ?? ((t: string) => controller.submit(t)))(text);
  };

  const complete = (name: string) => {
    setInput(`/${name} `);
    setHi(0);
  };

  const walkHistory = (dir: "up" | "down"): boolean => {
    const ta = inputRef.current;
    const h = history.current;
    if (!ta) return false;
    const row = ta.visualCursor.visualRow;
    if (dir === "up") {
      if (row > 0) return false;
      if (pos.current === -1) {
        if (h.length === 0) return true;
        draft.current = ta.plainText;
        pos.current = h.length - 1;
      } else if (pos.current > 0) pos.current--;
      else return true;
      setInput(h[pos.current]!);
      return true;
    }
    if (row < total.current - 1 || pos.current === -1) return false;
    if (pos.current < h.length - 1) setInput(h[++pos.current]!);
    else {
      pos.current = -1;
      setInput(draft.current);
    }
    return true;
  };

  useKeyboard((key) => {
    const L = live.current;
    if (!L.prompting) return; // the permission prompt and the picker own their keys
    const isCtrlC = key.ctrl && key.name === "c";
    if (!isCtrlC) disarm();
    const ta = inputRef.current;
    const text = ta?.plainText ?? "";

    if (key.name === "tab" && key.shift) {
      key.preventDefault();
      controller.cycleMode();
    } else if (key.name === "tab") {
      key.preventDefault();
      const m = L.matches[L.hi];
      if (m) complete(m.name);
    } else if (isCtrlC) {
      key.preventDefault();
      if (L.running && !interruptedRef.current) return interrupt();
      if (text !== "") return setInput("");
      if (armedRef.current) {
        disarm();
        return controller.exit();
      }
      arm();
    } else if (key.ctrl && key.name === "p") {
      // AIhub's command palette: every window and action, by name.
      key.preventDefault();
      controller.openPanel("palette");
    } else if (key.ctrl && key.name === "d") {
      if (text === "") {
        key.preventDefault();
        controller.exit();
      }
    } else if (key.name === "escape") {
      key.preventDefault();
      if (L.running && !interruptedRef.current) interrupt();
      else if (text !== "") setInput("");
    } else if (key.name === "up" || key.name === "down") {
      if (L.matches.length > 0) {
        key.preventDefault();
        const n = L.matches.length;
        const next = key.name === "up" ? (L.hi + n - 1) % n : (L.hi + 1) % n;
        L.hi = next;
        setHi(next);
      } else if (!key.shift && !key.ctrl && !key.meta && walkHistory(key.name)) key.preventDefault();
    } else if (key.name === "return" && !key.shift && !key.meta && !key.ctrl && L.matches.length > 0) {
      // A half-typed command is completed, an exact one runs.
      const typedName = text.slice(1).toLowerCase();
      if (!L.matches.some((c) => c.name.toLowerCase() === typedName)) {
        key.preventDefault();
        complete(L.matches[L.hi]!.name);
      }
    }
  });

  // ── what to draw, and how tall that is ───────────────────────────────────

  // Rows left inside the box once the gap line, the status line and the borders
  // are counted (no limit without maxHeight).
  const inner = maxHeight === undefined ? Infinity : Math.max(1, maxHeight - 4);
  const suggestRows = Math.min(MAX_SUGGESTIONS, matches.length, Math.max(0, inner - 1));
  const inputRows = Math.max(1, Math.min(rows, inner - suggestRows));
  const maxDiff = asking ? Math.max(0, inner - 1 - (st.permission!.suggestedRule ? 3 : 2)) : undefined;
  const permLayout = asking ? permissionLayout(st.permission!, Math.max(1, width - 4), 0, false, maxDiff) : null;
  const boxRows = permLayout
    ? permLayout.rows + 2
    : picking
      ? pickerInnerRows(st.picker!.items.length, inner) + 2
      : confirming
        ? CONFIRM_ROWS + 2
        : inputRows + 2;
  const height = paneled ? Math.max(5, (props.rows ?? DEFAULT_ROWS) - 1) : 1 + boxRows + suggestRows + 1;
  // A layout effect: the renderer's footer area is resized in the same commit as
  // the content, not a frame later (a taller footer in a shorter area is squeezed).
  useLayoutEffect(() => {
    onHeight?.(height);
  }, [height]);

  const hint = armed && prompting ? { text: "Press Ctrl+C again to exit", warn: true } : paneled ? { text: HINTS.panel } : asking ? { text: noting ? HINTS.note : HINTS.permission } : picking ? { text: HINTS.picker } : confirming ? { text: HINTS.confirm } : null;
  const status: StatusInput = {
    mode: st.mode,
    model: sanitize(st.model),
    ctx: st.ctx,
    queued: st.queue.length,
    hint,
  };

  return (
    <box flexDirection="column" width={width} height={height} flexShrink={0}>
      {st.activity && !asking && !picking && !confirming && !paneled ? (
        <ActivityLine activity={st.activity} now={now()} width={width} interruptible={running && !interrupted} />
      ) : (
        <box height={1} flexShrink={0} />
      )}
      {asking ? (
        <PermissionPrompt
          key={`${st.permission!.requestId}:${st.permission!.permissionId}`}
          controller={controller}
          permission={st.permission!}
          width={width}
          now={now}
          guardMs={permissionQuietMs}
          onEditing={setNoting}
          onInterrupt={interrupt}
          maxDiff={maxDiff}
        />
      ) : picking ? (
        <Picker picker={st.picker!} width={width} now={now} guardMs={guardMs} onPick={(id) => void controller.pick(id)} maxInner={inner} />
      ) : paneled ? (
        <PanelHost controller={controller} width={width} rows={height - 2} />
      ) : confirming ? (
        <ConfirmPrompt confirm={st.confirm!} width={width} now={now} guardMs={guardMs} onAnswer={(yes) => void controller.answerConfirm(yes)} />
      ) : (
        <PromptBox
          width={width}
          mode={st.mode}
          rows={inputRows}
          inputRef={inputRef}
          initialValue={lastText.current}
          onContentChange={sync}
          onSubmit={send}
        />
      )}
      {suggestRows > 0 ? <SlashSuggest items={matches} highlight={hiNow} width={width} maxRows={suggestRows} /> : null}
      <StatusLine input={status} width={width} />
    </box>
  );
}
