// Ported from AIhub-TUI v1.5.0 app/src/modals/HardwareModal.tsx.
/** @jsxImportSource ../jsx */
import { debugLog } from "../bridge/client.ts";
import { useEffect, useState } from "react";
import type { ColorInput } from "@opentui/core";
import { theme, fit } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { Meter, SectionLabel, Spinner } from "../ui/primitives.tsx";
import { useModalKeys } from "./modalKit.ts";

interface Scan {
  os?: any;
  cpu?: any;
  ram?: any;
  disk?: any;
  gpu?: any;
}

function Line({ k, v, ok }: { k: string; v: string; ok?: ColorInput }) {
  return (
    <text>
      <span fg={theme.fg2}>{`  ${k.padEnd(10)}`}</span>
      <span fg={ok || theme.fg0}>{v}</span>
    </text>
  );
}

/** Spec sheet + live utilization. Scans once, polls usage every 3 s. */
export function HardwareModal({
  model,
  onClose,
}: {
  model: string | null;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [scan, setScan] = useState<Scan | null>(null);
  const [usage, setUsage] = useState<any>(null);
  const [err, setErr] = useState("");
  // The machine running Ollama — a server, possibly, not this computer.
  const [target, setTarget] = useState<any>(null);
  const width = useShellWidth(64);
  const barW = 30;

  useEffect(() => {
    let alive = true;
    bridge
      .request("target.info")
      .then((d) => alive && setTarget(d))
      .catch((e) => debugLog(`target.info failed: ${(e as Error).message || e}`));
    bridge
      .request("hardware.scan")
      .then((d) => alive && setScan(d))
      .catch((e) => alive && setErr(String((e as Error).message || e)));
    const poll = () =>
      bridge
        .request("hardware.usage", { model: model || undefined })
        .then((d) => alive && setUsage(d))
        // Polled every tick: log it rather than flash an error each second.
        .catch((e) => debugLog(`hardware.usage failed: ${(e as Error).message || e}`));
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [model]);

  useModalKeys([{ key: "escape", run: onClose }]);

  const gpuUtil = usage?.gpu?.util_percent ?? -1;
  const vramU = (usage?.gpu?.vram_used_mb ?? 0) / 1024;
  const vramT = (usage?.gpu?.vram_total_mb ?? 0) / 1024;
  const cpuPct = usage?.cpu ?? 0;
  const ram = scan?.ram;
  const disk = scan?.disk;
  const placement = usage?.placement || {};
  const gpuFrac = placement.gpu_fraction;

  const utilColorLive = (p: number) => (p < 0 ? theme.fg2 : p < 60 ? theme.success : p < 85 ? theme.warn : theme.error);

  return (
    <ModalShell title="Hardware" width={width} height={26} hints={[["esc", "close"]]}>
      {!scan && !err ? (
        <text fg={theme.fg2}>
          {"  scanning"}
          <Spinner color={theme.fg2} />
        </text>
      ) : null}
      {err ? <text fg={theme.error}>{`  ${fit(err, width - 8)}`}</text> : null}

      {scan ? (
        <box flexDirection="column" paddingTop={1}>
          {target ? (
            <box flexDirection="column" flexShrink={0}>
              <SectionLabel label="ollama — where models run" width={width - 4} />
              <Line k="runs on" v={fit(String(target.label), width - 16)} />
              <Line
                k="gpu"
                v={fit(
                  `${target.vram_gb ? `~${target.vram_gb} GB (${target.vram_basis})` : "none — CPU"}` +
                    ` · ${Math.round(target.bw_eff)} GB/s (${target.bw_basis})`,
                  width - 16,
                )}
              />
              {model ? (
                <text>
                  <span fg={theme.fg2}>{"  model     "}</span>
                  <span fg={theme.fg1}>{fit(model, width - 34)}</span>
                  <span fg={gpuFrac != null && gpuFrac >= 1 ? theme.success : gpuFrac ? theme.warn : theme.fg2}>
                    {gpuFrac == null
                      ? "  · not loaded now"
                      : gpuFrac >= 1
                        ? "  · on GPU (100%)"
                        : gpuFrac > 0
                          ? `  · ${Math.round(gpuFrac * 100)}% on GPU`
                          : "  · on CPU"}
                  </span>
                </text>
              ) : null}
            </box>
          ) : null}
          <box marginTop={1} flexShrink={0}>
            <SectionLabel label={target?.where === "server" ? "this computer" : "system"} width={width - 4} />
          </box>
          <Line k="OS" v={fit(String(scan.os || "?"), width - 16)} />
          <Line
            k="cpu"
            v={fit(`${scan.cpu?.model || "?"}  (${scan.cpu?.cores_physical ?? "?"}c/${scan.cpu?.cores_logical ?? "?"}t)`, width - 16)}
          />
          <Line k="RAM" v={`${(ram?.total_gb ?? 0).toFixed(1)}G total · ${(ram?.available_gb ?? 0).toFixed(1)}G free`} />
          <Line k="DISK" v={`${(disk?.total_gb ?? 0).toFixed(0)}G total · ${(disk?.free_gb ?? 0).toFixed(0)}G free`} />
          <Line
            k="gpu"
            v={
              scan.gpu?.model
                ? `${scan.gpu.model} · ${(scan.gpu.vram_total_mb / 1024).toFixed(1)}G VRAM`
                : "none detected"
            }
            ok={scan.gpu?.model ? theme.fg0 : theme.warn}
          />

          <box marginTop={1} flexDirection="column">
            <SectionLabel label="live" width={width - 4} />
            <box flexDirection="row">
              <text fg={theme.fg2}>{"  cpu       "}</text>
              <Meter fraction={cpuPct / 100} width={barW} color={utilColorLive(cpuPct)} />
              <text fg={theme.fg1}>{` ${Math.round(cpuPct)}%`}</text>
            </box>
            <box flexDirection="row">
              <text fg={theme.fg2}>{"  gpu       "}</text>
              <Meter
                fraction={gpuUtil < 0 ? 0 : gpuUtil / 100}
                width={barW}
                color={utilColorLive(gpuUtil)}
              />
              <text fg={theme.fg1}>{` ${gpuUtil < 0 ? "—" : `${Math.round(gpuUtil)}%`}`}</text>
            </box>
            <box flexDirection="row">
              <text fg={theme.fg2}>{"  vram      "}</text>
              <Meter fraction={vramT ? vramU / vramT : 0} width={barW} color={theme.accent} />
              <text fg={theme.fg1}>{` ${vramU.toFixed(1)}/${vramT.toFixed(1) || "—"}G`}</text>
            </box>
          </box>

        </box>
      ) : null}
    </ModalShell>
  );
}
