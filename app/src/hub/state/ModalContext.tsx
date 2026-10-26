// Ported from AIhub-TUI v1.5.0 app/src/state/ModalContext.tsx.
/** @jsxImportSource ../jsx */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { theme } from "../theme.ts";
import { ShellContext } from "../ui/ModalShell.tsx";
import { useThemeVersion } from "./useTheme.ts";

/** A modal is rendered by a factory that receives a `close(value)` callback,
 *  mirroring Textual's push_screen/dismiss. */
export type ModalFactory<T> = (close: (value: T) => void) => ReactNode;

interface ModalEntry {
  id: number;
  render: (close: (value: any) => void) => ReactNode;
  resolve: (value: any) => void;
  /** false: no full-screen backdrop — the app stays visible around the modal
   *  (the theme picker, so the whole interface is the preview). */
  backdrop: boolean;
}

export interface ModalOptions {
  backdrop?: boolean;
}

interface ModalApi {
  push<T = void>(factory: ModalFactory<T>, options?: ModalOptions): Promise<T>;
  depth: number;
  isOpen: boolean;
}

const ModalContext = createContext<ModalApi | null>(null);

let _modalId = 1;

export function ModalProvider({ children }: { children: ReactNode }) {
  // Modals are re-created from their factories on render: a theme switch
  // repaints the open ones (the theme picker itself included).
  useThemeVersion();
  const [stack, setStack] = useState<ModalEntry[]>([]);
  const footer = useContext(ShellContext).footer;

  const close = useCallback((id: number, value: any) => {
    setStack((s) => {
      const entry = s.find((e) => e.id === id);
      entry?.resolve(value);
      return s.filter((e) => e.id !== id);
    });
  }, []);

  const push = useCallback(<T,>(factory: ModalFactory<T>, options?: ModalOptions): Promise<T> => {
    return new Promise<T>((resolve) => {
      const id = _modalId++;
      setStack((s) => [...s, { id, render: factory as any, resolve, backdrop: options?.backdrop !== false }]);
    });
  }, []);

  // Memoised: a fresh object here re-renders every consumer (the whole chat
  // screen) on any unrelated state change.
  const api: ModalApi = useMemo(
    () => ({ push, depth: stack.length, isOpen: stack.length > 0 }),
    [push, stack.length],
  );

  // aihub-code: in the footer every window fills the panel, and the theme may
  // paint no backdrop, so one stacked above another would show through it.
  // The top one is drawn alone; those under it stay mounted, hidden, and come
  // back as they were when it closes.
  if (footer)
    return (
      <ModalContext.Provider value={api}>
        <box width="100%" height="100%" flexDirection="column">
          <box visible={stack.length === 0} width="100%" height="100%" flexDirection="column">
            {children}
          </box>
          {stack.map((entry, i) => (
            <box key={entry.id} visible={i === stack.length - 1} width="100%" height="100%" flexDirection="column">
              {entry.render((value) => close(entry.id, value))}
            </box>
          ))}
        </box>
      </ModalContext.Provider>
    );

  return (
    <ModalContext.Provider value={api}>
      <box width="100%" height="100%">
        {children}
        {stack.map((entry, i) => (
          <box
            key={entry.id}
            position="absolute"
            left={0}
            top={0}
            width="100%"
            height="100%"
            backgroundColor={entry.backdrop ? theme.bg0 : undefined}
            zIndex={100 + i}
            alignItems="center"
            justifyContent="center"
          >
            {entry.render((value) => close(entry.id, value))}
          </box>
        ))}
      </box>
    </ModalContext.Provider>
  );
}

export function useModals(): ModalApi {
  const c = useContext(ModalContext);
  if (!c) throw new Error("useModals must be used within a ModalProvider");
  return c;
}
