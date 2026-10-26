// Ported from AIhub-TUI v1.5.0 app/src/state/SessionContext.tsx.
/** @jsxImportSource ../jsx */
import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { Backend, ChatMessage } from "../bridge/types.ts";

/** Mirrors tui/state.py SessionState plus the live status fields the bars read. */
export interface SessionState {
  modelName: string | null;
  streamModel: string; // actual id passed to the backend (e.g. api:// url)
  backend: Backend;
  messages: ChatMessage[];
  temperature: number;
  contextLength: number;
  memoryEnabled: boolean;
  toolsEnabled: boolean;
  mode: "chat" | "agent";
  agentSubmode: "plan" | "build";
  /** The active agent profile's name (meaningful in agent mode). */
  agentName: string;
  /** Knowledge bases switched on for this chat with /kb (agents add theirs). */
  knowledge: string[];
  sessionTokens: number;
  ctxUsed: number;
  ctxMax: number;
  tps: number;
  startTime: string; // ISO

  // live status
  streaming: boolean;
  /** null until the first status check answers. */
  ollamaOnline: boolean | null;
  llamacppOnline: boolean;
  llamacppModel: string;

  /** Where the model runs on the Ollama machine; null = not known (not
   *  asked yet, Ollama offline, or not an Ollama model). */
  modelLocation: ModelLocation | null;
}

/** As models.location reports it, from Ollama's /api/ps. */
export type ModelLocation =
  | { state: "gpu" | "split" | "cpu"; gpu_fraction: number; vram_gb: number; size_gb: number }
  | { state: "unloaded" | "cloud" };

export function initialSession(): SessionState {
  return {
    modelName: null,
    streamModel: "",
    backend: "ollama",
    messages: [],
    temperature: 0.7,
    contextLength: 2048,
    memoryEnabled: true,
    toolsEnabled: true,
    mode: "chat",
    agentSubmode: "build",
    agentName: "coder",
    knowledge: [],
    sessionTokens: 0,
    ctxUsed: 0,
    ctxMax: 2048,
    tps: 0,
    startTime: new Date().toISOString(),
    streaming: false,
    ollamaOnline: null,
    llamacppOnline: false,
    llamacppModel: "",
    modelLocation: null,
  };
}

type Action =
  | { type: "patch"; patch: Partial<SessionState> }
  | { type: "addUsage"; promptTokens: number; completionTokens: number; tps: number }
  | { type: "newChat" }
  | { type: "reset"; state: SessionState };

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.patch };
    case "addUsage":
      return {
        ...state,
        tps: action.tps,
        ctxUsed: action.promptTokens || state.ctxUsed,
        sessionTokens: state.sessionTokens + (action.completionTokens || 0),
      };
    case "newChat":
      return {
        ...state,
        messages: [],
        sessionTokens: 0,
        ctxUsed: 0,
        tps: 0,
        mode: "chat",
        agentSubmode: "build",
        knowledge: [],
        streaming: false,
        startTime: new Date().toISOString(),
      };
    case "reset":
      return action.state;
  }
}

const SessionContext = createContext<{
  state: SessionState;
  dispatch: Dispatch<Action>;
} | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialSession);
  return (
    <SessionContext.Provider value={{ state, dispatch }}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  const c = useContext(SessionContext);
  if (!c) throw new Error("useSession must be used within a SessionProvider");
  return c;
}
