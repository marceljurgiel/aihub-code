// Ported from AIhub-TUI v1.5.0 app/src/modals/MissedTasksModal.tsx.
/** @jsxImportSource ../jsx */
import { theme, fit } from "../theme.ts";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { useModalKeys } from "./modalKit.ts";
import { formatSlot } from "../schedule/format.ts";
import type { MissedTask } from "../schedule/types.ts";

/** At startup, one task whose time passed while AIhub was closed: run it now
 *  or skip that slot (not asked again). */
export function MissedTasksModal({
  task,
  index,
  total,
  onClose,
}: {
  task: MissedTask;
  index: number;
  total: number;
  onClose: (choice: "run" | "skip") => void;
}) {
  useModalKeys([
    { key: "return", run: () => onClose("run") },
    { key: "s", run: () => onClose("skip") },
    { key: "escape", run: () => onClose("skip") },
  ]);
  const width = useShellWidth(64);
  return (
    <ModalShell
      title={total > 1 ? `Missed task ${index + 1}/${total}` : "Missed task"}
      width={width}
      hints={[["enter", "run now"], ["s", "skip"]]}
    >
      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <text fg={theme.fg1}>{"  Missed while AIhub was closed:"}</text>
        <text>
          <span fg={theme.fg0}>{`    ${fit(task.name, 24)}`}</span>
          <span fg={theme.fg2}>{fit(`  (${task.when}, due ${formatSlot(task.slot)})`, width - 32)}</span>
        </text>
        <text fg={theme.fg2}>{"  Tasks run only while AIhub is open."}</text>
      </box>
    </ModalShell>
  );
}
