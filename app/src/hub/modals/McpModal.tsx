// Ported from AIhub-TUI v1.5.0 app/src/modals/McpModal.tsx.
/** @jsxImportSource ../jsx */
import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { singleLinePaste } from "../clipboard.ts";
import type { ColorInput } from "@opentui/core";
import { theme, fit, lift } from "../theme.ts";
import { useBridge } from "../state/BridgeContext.tsx";
import { ModalShell, useShellWidth } from "../ui/ModalShell.tsx";
import { ListRow, Spinner } from "../ui/primitives.tsx";
import { useModalKeys, useWindowedList } from "./modalKit.ts";

interface McpTool {
  name: string;
  description: string;
  read_only: boolean;
  enabled: boolean;
}

interface McpServer {
  name: string;
  enabled: boolean;
  status: string; // connected | starting | error | stopped | off
  error: string;
  transport: string;
  command: string;
  keywords: string[];
  tools: McpTool[];
}

type View = "list" | "tools" | "add" | "catalog" | "form" | "google" | "own";

interface CatalogField {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
}

interface CatalogItem {
  id: string;
  name: string;
  category: string;
  description: string;
  fields: CatalogField[];
  steps: string[];
  installed: boolean;
  prefill: Record<string, string>;
  /** "google": connects by signing in, not with a form. */
  connect?: string;
}

/** The servers "Connect Google" installs — one sign-in for all three. */
const GOOGLE_SERVERS = ["gmail", "calendar", "drive"];
const GOOGLE_LABEL: Record<string, string> = { gmail: "Gmail", calendar: "Calendar", drive: "Drive" };

interface GoogleStatus {
  connected: boolean;
  email: string;
  builtin: boolean;
  own_client: boolean;
}

/** One "Connect Google" attempt, as the engine reports it. */
interface GoogleFlow {
  phase: "opening" | "waiting" | "installing" | "done" | "error";
  url: string;
  opened: boolean;
  service: string;
  own: boolean;
  email: string;
  services: string[];
  missing: string[];
  error: string;
}

/** Catalog rows after the servers: import from Claude, then a custom one. */
type CatalogRow = { kind: "item"; item: CatalogItem } | { kind: "claude"; names: string[] } | { kind: "custom" };

const VIEWPORT = 8;

/** Status colour — a function, so it follows the live theme. */
const statusColor = (s: string): ColorInput =>
  ({
    connected: theme.success,
    starting: theme.warn,
    error: theme.error,
  })[s] ?? theme.fg2;

/**
 * Connections — the services AIhub can use (Google, GitHub, Notion, files…).
 * Under the hood each one is an MCP server; its tools reach the model only
 * when a request is about that service, and anything that changes something
 * asks for approval first. Google connects by signing in once.
 */
export function McpModal({ onClose }: { onClose: () => void }) {
  const bridge = useBridge();
  const term = useTerminalDimensions();
  const width = useShellWidth(Math.max(60, Math.min(100, term.width - 4)));
  const [servers, setServers] = useState<McpServer[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [view, setView] = useState<View>("list");
  const [armed, setArmed] = useState<string | null>(null);
  // Catalog: entries, Claude's servers to import, and the form being filled.
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [claudeNames, setClaudeNames] = useState<string[]>([]);
  const [formItem, setFormItem] = useState<CatalogItem | null>(null);
  const [field, setField] = useState(0);
  const formVals = useRef<Record<string, string>>({});
  // Connect Google: the sign-in in progress, and the user's own-app wizard.
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [flow, setFlow] = useState<GoogleFlow | null>(null);
  const flowReq = useRef<number | null>(null);
  const [ownSteps, setOwnSteps] = useState<Array<{ text: string; url: string }>>([]);
  const ownSince = useRef(0);
  const lastPaste = useRef(0);
  const inputEl = useRef<any>(null);
  const busyRef = useRef(false);
  const list = useWindowedList(servers.length, VIEWPORT);
  const catRows: CatalogRow[] = [
    ...catalog.map((item) => ({ kind: "item" as const, item })),
    ...(claudeNames.length ? [{ kind: "claude" as const, names: claudeNames }] : []),
    { kind: "custom" as const },
  ];
  const cat = useWindowedList(catRows.length, VIEWPORT + 3);
  const catRow = catRows[cat.index] ?? null;
  const selected = servers[list.index] ?? null;
  const tools = useWindowedList(selected?.tools.length ?? 0, VIEWPORT + 3);
  const tool = selected?.tools[tools.index] ?? null;

  const refreshGoogle = () =>
    bridge
      .request("google.status")
      .then((d) => setGoogle(d))
      .catch(() => setGoogle(null));

  const refresh = (connect = false) =>
    bridge
      .request("mcp.list", { connect })
      .then((d) => {
        setServers(d.servers || []);
        setConfigPath(d.config || "");
      })
      .catch((e) => setNote(String((e as Error).message || e)))
      .finally(() => setLoading(false));

  useEffect(() => {
    // Show what's configured at once, then connect the enabled servers.
    void refresh(false).then(() => refresh(true));
    void refreshGoogle();
  }, []);

  const run = (label: string, p: Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setNote("");
    p.catch((e) => setNote(String((e as Error).message || e))).finally(() => {
      busyRef.current = false;
      setBusy("");
    });
  };

  const toggleServer = () => {
    if (!selected) return;
    run(
      selected.enabled ? `stopping ${selected.name}…` : `starting ${selected.name}…`,
      bridge.request("mcp.enable", { name: selected.name, enabled: !selected.enabled }).then(() => refresh(true)),
    );
  };

  const toggleTool = () => {
    if (!selected || !tool) return;
    bridge
      .request("mcp.tool_enable", { name: selected.name, tool: tool.name, enabled: !tool.enabled })
      .then(() => refresh(false))
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const restart = () => {
    if (!selected) return;
    run(
      `restarting ${selected.name}…`,
      bridge.request("mcp.restart", { name: selected.name }).then((d) => {
        setNote(`${selected.name}: ${d.tools} tools.`);
        return refresh(false);
      }),
    );
  };

  const remove = () => {
    if (!selected) return;
    if (google?.connected && GOOGLE_SERVERS.includes(selected.name)) {
      if (armed !== "google") {
        setArmed("google");
        return setNote(`Press d again to disconnect Google (${google.email}): Gmail, Calendar and Drive.`);
      }
      return run(
        "disconnecting Google…",
        bridge.request("google.disconnect").then((d) => {
          setArmed(null);
          setNote(
            d?.revoked
              ? "Google disconnected — AIhub's access was revoked at Google too."
              : "Google disconnected here; Google unreachable, so revoke at myaccount.google.com/permissions",
          );
          void refreshGoogle();
          return refresh(false);
        }),
      );
    }
    if (armed !== selected.name) {
      setArmed(selected.name);
      return setNote(`Press d again to remove ${selected.name} from ${configPath}.`);
    }
    run(
      `removing ${selected.name}…`,
      bridge.request("mcp.remove", { name: selected.name }).then(() => {
        setArmed(null);
        setNote(`Removed ${selected.name}.`);
        return refresh(false);
      }),
    );
  };

  const submitAdd = (text?: string) => {
    const value = String(text ?? inputEl.current?.value ?? "").trim();
    if (!value) return;
    run(
      "adding and starting the server…",
      bridge.request("mcp.add", { text: value }).then((d) => {
        const res = Object.entries(d.added || {}) as Array<[string, any]>;
        setNote(res.map(([n, r]) => (r.ok ? `${n}: ${r.tools} tools` : `${n}: ${r.error}`)).join(" · "));
        setView("list");
        return refresh(false);
      }),
    );
  };

  const openCatalog = () => {
    setNote("");
    cat.setIndex(0);
    setView("catalog");
    bridge
      .request("mcp.catalog")
      .then((d) => {
        setCatalog(d.items || []);
        setClaudeNames(d.claude || []);
      })
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const install = (item: CatalogItem, values: Record<string, string>) =>
    run(
      `installing ${item.name} (the first time can take a minute)…`,
      bridge.request("mcp.install", { id: item.id, values }).then((d) => {
        setNote(`${item.name} connected — ${d.tools} tools. Mention it in a message and the model can use it.`);
        setView("list");
        return refresh(false);
      }),
    );

  /** Sign in with Google: the engine opens the browser and waits for it. */
  const startGoogle = (own: boolean) => {
    setNote("");
    setFlow({ phase: "opening", url: "", opened: false, service: "", own, email: "", services: [], missing: [], error: "" });
    setView("google");
    const patch = (p: Partial<GoogleFlow>) => setFlow((f) => (f ? { ...f, ...p } : f));
    const s = bridge.stream("google.connect", { own }, {
      onEvent: (event: string, data: any) => {
        if (event === "opening") patch({ url: data?.url || "", opened: !!data?.opened });
        else if (event === "waiting") patch({ phase: "waiting" });
        else if (event === "installing") patch({ phase: "installing", service: data?.service || "" });
      },
    });
    flowReq.current = s.id;
    s.done
      .then((d: any) => {
        flowReq.current = null;
        if (d?.cancelled) return;
        patch({ phase: "done", email: d.email, services: d.services || [], missing: d.missing || [] });
        void refreshGoogle();
        return refresh(true);
      })
      .catch((e) => {
        flowReq.current = null;
        patch({ phase: "error", error: String((e as Error).message || e) });
      });
  };

  /** Your own Google app: guided steps; the client file is picked up from
   *  Downloads as soon as Google Cloud saves it. */
  const openOwn = () => {
    setNote("");
    ownSince.current = Date.now() / 1000;
    setView("own");
    bridge
      .request("google.own_steps")
      .then((d) => setOwnSteps(d.steps || []))
      .catch((e) => setNote(String((e as Error).message || e)));
  };
  useEffect(() => {
    if (view !== "own") return;
    const t = setInterval(() => {
      bridge
        .request("google.import_client", { since: ownSince.current })
        .then((d) => {
          if (!d?.found) return;
          clearInterval(t);
          startGoogle(true);
        })
        .catch((e) => setNote(String((e as Error).message || e)));
    }, 2000);
    return () => clearInterval(t);
  }, [view]);

  /** Enter in the wizard: a client file downloaded earlier is fine too. */
  const importNewest = () =>
    run(
      "looking in Downloads…",
      bridge.request("google.import_client", {}).then(() => startGoogle(true)),
    );

  const connectGoogle = () =>
    bridge
      .request("google.status")
      .then((st: GoogleStatus) => {
        setGoogle(st);
        if (st.builtin) return startGoogle(false);
        if (st.own_client) return startGoogle(true);
        openOwn();
      })
      .catch((e) => setNote(String((e as Error).message || e)));

  const cancelGoogle = () => {
    if (flowReq.current != null) bridge.cancel(flowReq.current);
    flowReq.current = null;
  };

  const pasteRedirect = (text?: string) => {
    const value = String(text ?? inputEl.current?.value ?? "").trim();
    // Enter reaches both the modal keymap and the input: send once.
    if (!value || Date.now() - lastPaste.current < 300) return;
    lastPaste.current = Date.now();
    bridge
      .request("google.paste", { url: value })
      .then(() => setNote(""))
      .catch((e) => setNote(String((e as Error).message || e)));
  };

  const pickCatalogRow = () => {
    if (!catRow) return;
    if (catRow.kind === "custom") return (setNote(""), setView("add"));
    if (catRow.kind === "claude")
      return run(
        "importing from Claude…",
        bridge.request("mcp.import_claude").then((d) => {
          setNote(
            `Imported ${d.added.length ? d.added.join(", ") : "nothing new"}` +
              (d.skipped.length ? ` · already here: ${d.skipped.join(", ")}` : ""),
          );
          setView("list");
          return refresh(true);
        }),
      );
    const item = catRow.item;
    if (item.connect === "google") return connectGoogle();
    if (!item.fields.length) return install(item, {});
    formVals.current = { ...item.prefill };
    setFormItem(item);
    setField(0);
    setNote("");
    setView("form");
    setTimeout(() => {
      if (inputEl.current) inputEl.current.value = item.prefill[item.fields[0]!.key] ?? "";
    }, 0);
  };

  // Enter reaches both the modal keymap and the input: one step per press.
  const lastSubmit = useRef(0);
  const submitForm = (text?: string) => {
    if (!formItem || Date.now() - lastSubmit.current < 150) return;
    lastSubmit.current = Date.now();
    const f = formItem.fields[field]!;
    formVals.current[f.key] = String(text ?? inputEl.current?.value ?? "").trim();
    if (field < formItem.fields.length - 1) {
      const next = formItem.fields[field + 1]!;
      setField(field + 1);
      if (inputEl.current) inputEl.current.value = formVals.current[next.key] ?? "";
      return;
    }
    install(formItem, formVals.current);
  };

  const typing = view === "add" || view === "form" || (view === "google" && flow?.phase === "waiting");
  const back = () => {
    if (view === "list") return onClose();
    setNote("");
    if (view === "google") {
      cancelGoogle();
      const done = flow?.phase === "done";
      setFlow(null);
      return setView(done ? "list" : "catalog");
    }
    setView(view === "form" || view === "add" || view === "own" ? "catalog" : "list");
  };

  useModalKeys([
    { key: "escape", run: back },
    { key: "up", run: () => (view === "tools" ? tools.up() : view === "catalog" ? cat.up() : list.up()) },
    { key: "down", run: () => (view === "tools" ? tools.down() : view === "catalog" ? cat.down() : list.down()) },
    {
      key: "return",
      run: () =>
        view === "list"
          ? selected && setView("tools")
          : view === "catalog"
            ? pickCatalogRow()
            : view === "add"
              ? submitAdd()
              : view === "form"
                ? submitForm()
                : view === "google" && flow?.phase === "waiting"
                  ? pasteRedirect()
                  : view === "google" && flow?.phase === "error"
                    ? startGoogle(flow.own)
                    : view === "own"
                      ? importNewest()
                      : back(),
    },
  ]);
  useModalKeys(
    [
      { key: "t", run: () => (view === "list" ? toggleServer() : view === "tools" ? toggleTool() : undefined) },
      { key: "r", run: () => view === "list" && restart() },
      { key: "d", run: () => view === "list" && remove() },
      { key: "a", run: () => view === "list" && openCatalog() },
      { key: "o", run: () => view === "google" && flow?.phase === "error" && openOwn() },
      ...[1, 2, 3, 4].map((n) => ({
        key: String(n),
        run: () => {
          const st = view === "own" ? ownSteps[n - 1] : undefined;
          if (st) bridge.request("system.open_url", { url: st.url }).catch(() => {});
        },
      })),
    ],
    { enabled: () => !typing },
  );

  const hints: Array<[string, string]> =
    view === "list"
      ? [["↵", "tools"], ["t", "on/off"], ["a", "add"], ["r", "restart"], ["d", "remove"]]
      : view === "tools"
        ? [["↑↓", "select"], ["t", "on/off"], ["esc", "back"]]
        : view === "catalog"
          ? [["↑↓", "select"], ["↵", "connect"], ["esc", "back"]]
          : view === "google"
            ? flow?.phase === "error"
              ? [["enter", "try again"], ["o", "use my own Google app"], ["esc", "back"]]
              : flow?.phase === "done"
                ? [["esc", "done"]]
                : [["enter", "use pasted address"], ["esc", "cancel"]]
            : view === "own"
              ? [["1-4", "open step"], ["enter", "use the newest download"], ["esc", "back"]]
              : [["enter", view === "form" && formItem && field < formItem.fields.length - 1 ? "next" : "install"], ["esc", "back"]];

  return (
    <ModalShell title="Connections" width={width} height={VIEWPORT + 15} hints={hints}>
      {view === "list" ? (
        <box key="list" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexDirection="column" height={VIEWPORT} flexShrink={0}>
            {loading ? (
              <text fg={theme.fg2}>{"  loading…"}</text>
            ) : servers.length === 0 ? (
              <text fg={theme.fg2} wrapMode="word">
                {"  Nothing connected yet. Connections let AIhub use your services — mail, calendar, files, GitHub… Press a to add one."}
              </text>
            ) : (
              servers.slice(list.start, list.end).map((s, i) => {
                const idx = list.start + i;
                const sel = idx === list.index;
                const on = s.tools.filter((t) => t.enabled).length;
                return (
                  <ListRow key={s.name} selected={sel} onSelect={() => list.setIndex(idx)}>
                    <text>
                      <span fg={sel ? theme.fg0 : theme.fg1}>{` ${fit(s.name, 16).padEnd(19)}`}</span>
                      <span fg={statusColor(s.status)}>{s.status.padEnd(11)}</span>
                      <span fg={theme.fg2}>{(s.tools.length ? `${on}/${s.tools.length} tools` : "").padEnd(12)}</span>
                      <span fg={theme.fg2}>{fit(s.command, width - 50)}</span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          <box flexDirection="column" flexShrink={0} marginTop={1} height={4}>
            {busy ? (
              <text fg={theme.fg2}>
                {"  "}
                <Spinner color={theme.fg2} />
                {` ${busy}`}
              </text>
            ) : selected?.error ? (
              <text fg={theme.error} wrapMode="word">{`  ${fit(selected.error, (width - 6) * 2)}`}</text>
            ) : selected ? (
              <text fg={theme.fg2}>
                {fit(
                  google?.connected && GOOGLE_SERVERS.includes(selected.name)
                    ? `  Google · ${google.email} · used when you mention ${GOOGLE_LABEL[selected.name]?.toLowerCase()} · d disconnects`
                    : `  used when you mention: ${[selected.name, ...selected.keywords].join(", ")}`,
                  width - 4,
                )}
              </text>
            ) : null}
            <text fg={theme.fg2}>{"  Changes (send, delete…) always ask you first."}</text>
            <text fg={theme.fg2}>{fit(`  ${configPath}`, width - 4)}</text>
          </box>
        </box>
      ) : view === "tools" && selected ? (
        <box key="tools" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexDirection="column" height={VIEWPORT + 3} flexShrink={0}>
            {selected.tools.length === 0 ? (
              <text fg={theme.fg2}>{`  ${selected.name} has no tools (${selected.status}).`}</text>
            ) : (
              selected.tools.slice(tools.start, tools.end).map((t, i) => {
                const idx = tools.start + i;
                const sel = idx === tools.index;
                return (
                  <ListRow key={t.name} selected={sel} onSelect={() => tools.setIndex(idx)}>
                    <text>
                      <span fg={t.enabled ? theme.success : theme.fg2}>{t.enabled ? " [✓] " : " [ ] "}</span>
                      <span fg={t.enabled ? (sel ? theme.fg0 : theme.fg1) : theme.fg2}>{fit(t.name, 32).padEnd(33)}</span>
                      <span fg={t.read_only ? theme.fg2 : theme.warn}>{t.read_only ? "reads  " : "changes"}</span>
                    </text>
                  </ListRow>
                );
              })
            )}
          </box>
          {tool ? (
            <text fg={theme.fg2} wrapMode="word">{`  ${fit(tool.description, (width - 6) * 2)}`}</text>
          ) : null}
        </box>
      ) : view === "catalog" ? (
        <box key="catalog" flexDirection="column" flexGrow={1} paddingTop={1}>
          <box flexDirection="column" height={VIEWPORT + 3} flexShrink={0}>
            {catRows.slice(cat.start, cat.end).map((r, i) => {
              const idx = cat.start + i;
              const sel = idx === cat.index;
              const name =
                r.kind === "item" ? r.item.name : r.kind === "claude" ? "Import from Claude" : "Custom (MCP)…";
              const desc =
                r.kind === "item"
                  ? r.item.description
                  : r.kind === "claude"
                    ? `${r.names.length} servers from Claude Code / Desktop: ${r.names.join(", ")}`
                    : "for developers: any Model Context Protocol server — paste its config or command";
              const need =
                r.kind === "item" ? (r.item.fields.length ? r.item.fields.map((f) => f.label).join(", ") : "nothing — one click") : "";
              return (
                <ListRow key={r.kind === "item" ? r.item.id : r.kind} selected={sel} onSelect={() => cat.setIndex(idx)}>
                  <text>
                    <span fg={r.kind === "item" && r.item.installed ? theme.success : theme.fg2}>
                      {r.kind === "item" && r.item.installed ? " ✓ " : "   "}
                    </span>
                    <span fg={sel ? theme.fg0 : theme.fg1}>{fit(name, 24).padEnd(25)}</span>
                    <span fg={theme.fg2}>{fit(desc, width - 34)}</span>
                  </text>
                </ListRow>
              );
            })}
          </box>
          {catRow?.kind === "item" ? (
            <text fg={theme.fg2}>
              {fit(
                catRow.item.connect === "google"
                  ? "  needs: just your Google sign-in — enter opens it in the browser"
                  : `  needs: ${catRow.item.fields.length ? catRow.item.fields.map((f) => f.label).join(", ") : "nothing — enter installs it"}`,
                width - 4,
              )}
            </text>
          ) : null}
          {busy ? (
            <text fg={theme.fg2}>
              {"  "}
              <Spinner color={theme.fg2} />
              {` ${busy}`}
            </text>
          ) : null}
        </box>
      ) : view === "google" && flow ? (
        <box key="google" flexDirection="column" flexGrow={1} paddingTop={1}>
          {flow.phase === "done" ? (
            <>
              <text fg={theme.success}>{`  ✓ Connected as ${flow.email}`}</text>
              <text fg={theme.fg1}>
                {`  ${flow.services.map((x) => GOOGLE_LABEL[x] ?? x).join(", ")} ready — the same sign-in for all of them.`}
              </text>
              {flow.missing.length ? (
                <text fg={theme.warn} wrapMode="word">
                  {`  Not allowed at Google: ${flow.missing.map((x) => GOOGLE_LABEL[x] ?? x).join(", ")} — connect again and tick those boxes to add them.`}
                </text>
              ) : null}
              <text fg={theme.fg2}>{"  "}</text>
              <text fg={theme.fg1}>{"  Try: “what's new in my inbox?” or “what's on my calendar this week?”"}</text>
              <text fg={theme.fg2}>{"  Sending, deleting or changing anything always asks you first."}</text>
            </>
          ) : flow.phase === "error" ? (
            <>
              <text fg={theme.error} wrapMode="word">{`  Google sign-in didn't finish: ${flow.error}`}</text>
              <text fg={theme.fg2}>{"  "}</text>
              <text fg={theme.fg1} wrapMode="word">
                {flow.own
                  ? "  Enter tries again."
                  : "  Enter tries again. If Google said the app has reached its user limit, press o to use your own Google app instead (a few steps, once)."}
              </text>
            </>
          ) : (
            <>
              <text fg={theme.fg0}>
                <Spinner color={theme.accent} />
                {flow.phase === "installing"
                  ? ` Signed in — setting up ${GOOGLE_LABEL[flow.service] ?? "Google"} (the first time takes a minute)…`
                  : flow.phase === "waiting"
                    ? " Waiting for you in the browser…"
                    : " Opening Google sign-in…"}
              </text>
              {flow.phase === "waiting" ? (
                <>
                  <text fg={theme.fg1} wrapMode="word">
                    {flow.opened
                      ? "  Pick your account and allow access. Google may warn that the app isn't verified: Advanced → Go to <your app's name>."
                      : "  Your browser didn't open — open this link:"}
                  </text>
                  {!flow.opened || flow.url ? (
                    <text fg={theme.accentSoft} wrapMode="char">{`  ${flow.url}`}</text>
                  ) : null}
                  <text fg={theme.fg2} wrapMode="word">
                    {"  Browser on another device? After allowing, paste the address it ends on (http://127.0.0.1…) here:"}
                  </text>
                  <box border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.bg2} flexShrink={0} paddingLeft={1}>
                    <input
                      ref={inputEl}
                      onPaste={singleLinePaste}
                      focused
                      placeholder="only needed when the browser is elsewhere"
                      onSubmit={(v: unknown) => pasteRedirect(typeof v === "string" ? v : undefined)}
                      backgroundColor={theme.bg2}
                      textColor={theme.fg0}
                      placeholderColor={theme.fg2}
                      cursorColor={theme.accent}
                    />
                  </box>
                </>
              ) : null}
            </>
          )}
        </box>
      ) : view === "own" ? (
        <box key="own" flexDirection="column" flexGrow={1} paddingTop={1}>
          <text fg={theme.fg0}>{"  Your own Google app — once, about 3 minutes:"}</text>
          {ownSteps.map((st, i) => (
            <text key={st.url}>
              <span fg={theme.fg1} bg={theme.bg3} {...lift()}>{` ${i + 1} `}</span>
              <span fg={theme.fg1}>{fit(` ${st.text}`, width - 8)}</span>
            </text>
          ))}
          <text fg={theme.fg2} wrapMode="word">{"  Press 1–4 to open each page in your browser."}</text>
          <text fg={theme.fg2}>{"  "}</text>
          <text fg={theme.fg1}>
            <Spinner color={theme.fg2} />
            {" Waiting for client_secret….json in Downloads — it's picked up as soon as you download it."}
          </text>
        </box>
      ) : (
        <box key={view} flexDirection="column" flexGrow={1} paddingTop={1}>
          {view === "add" ? (
            <>
              <text fg={theme.fg1}>{"  Paste a server's config (JSON from its README) or its command line:"}</text>
              <text fg={theme.fg2}>{fit("  e.g. npx -y @modelcontextprotocol/server-filesystem ~/Documents", width - 4)}</text>
            </>
          ) : formItem ? (
            <>
              <text fg={theme.fg0}>{`  ${formItem.name} — ${formItem.description}`}</text>
              {formItem.steps.map((st, i) => (
                <text key={st} fg={theme.fg2}>{fit(`  ${i + 1}. ${st}`, width - 4)}</text>
              ))}
              <text fg={theme.fg1}>
                {`  ${formItem.fields[field]!.label} (${field + 1}/${formItem.fields.length}):`}
              </text>
            </>
          ) : null}
          <box border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.bg2} flexShrink={0} paddingLeft={1} marginTop={1}>
            <input
              ref={inputEl}
              onPaste={singleLinePaste}
              focused={!busy}
              placeholder={view === "add" ? "JSON or command" : formItem?.fields[field]?.placeholder ?? ""}
              onSubmit={(v: unknown) => (view === "add" ? submitAdd : submitForm)(typeof v === "string" ? v : undefined)}
              backgroundColor={theme.bg2}
              textColor={theme.fg0}
              placeholderColor={theme.fg2}
              cursorColor={theme.accent}
            />
          </box>
          {busy ? (
            <text fg={theme.fg2}>
              {"  "}
              <Spinner color={theme.fg2} />
              {` ${busy}`}
            </text>
          ) : null}
        </box>
      )}

      {note ? (
        <box flexShrink={0}>
          <text fg={theme.warn}>{fit(note, width - 6)}</text>
        </box>
      ) : null}
    </ModalShell>
  );
}
