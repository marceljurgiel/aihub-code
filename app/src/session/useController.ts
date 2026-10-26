import { useSyncExternalStore } from "react";
import type { Controller, ControllerState } from "./controller";

/** The controller's state as a React value; re-renders on every change. */
export function useController(controller: Controller): ControllerState {
  return useSyncExternalStore(controller.subscribe, controller.getState);
}
