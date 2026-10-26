/** Types mirroring the Python NDJSON bridge protocol (aihub/bridge.py). */

export interface BridgeRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** A message received from the bridge. */
export interface BridgeMessage {
  id: number | null;
  event?: string;
  data?: any;
  done?: boolean;
  error?: string;
}

/** Handlers for a streaming request. */
export interface StreamHandlers {
  onEvent?: (event: string, data: any) => void;
}

// ── Domain shapes (subset used by the UI) ────────────────────────────────────

export interface InstalledModel {
  name: string;
  size_gb: number;
}

export interface BackendStatus {
  ollama_online: boolean;
  llamacpp_online: boolean;
  llamacpp_model: string;
}

export interface HardwareScan {
  os: string;
  cpu: { model: string; cores_physical: number; cores_logical: number; usage_percent: number };
  ram: { total_gb: number; available_gb: number; percent_used: number };
  disk: { total_gb: number; free_gb: number; percent_used: number };
  gpu: { vendor: string; model: string; vram_total_mb: number; vram_free_mb: number };
}

export interface UsageSnapshot {
  gpu: { util_percent?: number; vram_used_mb?: number; vram_total_mb?: number };
  cpu: number;
  placement: { size?: number; size_vram?: number; gpu_fraction?: number };
}

export type ChatMessage = {
  role: string;
  content: string;
  tool_calls?: unknown;
  /** Attached image ids (the engine stores the files and sends the data). */
  images?: string[];
};

/** An image attached to the prompt, as the engine stored it. */
export type Attachment = { id: string; name: string; width: number; height: number; kb: number };

export type Backend = "ollama" | "llamacpp" | "api";
