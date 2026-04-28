import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

type DeviceState = {
  device_id: string;
  ts?: number;
  iso?: string;
  online?: boolean;
  uptime_sec?: number;
  app?: {
    service?: string;
    active?: string;
    enabled?: string;
  };
  reason?: string;
};

type DeviceTelemetry = {
  device_id: string;
  ts?: number;
  iso?: string;
  name?: string;
  location?: string;
  hostname?: string;
  app_runtime?: any;
};

type Device = {
  device_id: string;
  last_seen_ts?: number;
  status?: DeviceState;
  telemetry?: DeviceTelemetry;
};

function classNames(...xs: Array<string | false | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function fmtAgeSeconds(ts?: number) {
  if (!ts) return "—";
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (age < 60) return `${age}s`;
  const m = Math.floor(age / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function fmtUptime(sec?: number) {
  if (sec === undefined || sec === null) return "—";
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

function Chip({ tone, children }: { tone: "good" | "bad" | "warn" | "muted"; children: any }) {
  const cls =
    tone === "good"
      ? "bg-good/15 text-good border-good/25"
      : tone === "bad"
        ? "bg-bad/15 text-bad border-bad/25"
        : tone === "warn"
          ? "bg-warn/15 text-warn border-warn/25"
          : "bg-white/5 text-muted border-white/10";
  return <span className={classNames("inline-flex items-center rounded-full border px-2 py-1 text-xs font-semibold", cls)}>{children}</span>;
}

export function App() {
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [lastResp, setLastResp] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "online" | "offline">("all");
  const [busyCmd, setBusyCmd] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "good" | "bad" | "muted"; text: string } | null>(null);
  const [updateUrl, setUpdateUrl] = useState("");
  const [updateVersion, setUpdateVersion] = useState("");
  const [cfgKey, setCfgKey] = useState("");
  const [cfgValue, setCfgValue] = useState("");
  const [cfgRestart, setCfgRestart] = useState(true);
  const [pRaw17Endian, setPRaw17Endian] = useState<"big" | "little">("big");
  const [pRaw17Signed, setPRaw17Signed] = useState(false);
  const [pPipeline, setPPipeline] = useState("RNS+HKDF (actual)");
  const [pEcgSource, setPEcgSource] = useState("ECG 3bx en vivo");
  const [pEntropyThr, setPEntropyThr] = useState("0.85");
  const [pInvalidPolicy, setPInvalidPolicy] = useState("Descartar no válidas");
  const [pRecombine, setPRecombine] = useState("Mitad + mitad");
  const [pMaxInvalidPool, setPMaxInvalidPool] = useState("24");
  const [pKeepTailBits, setPKeepTailBits] = useState(true);
  const [pAnalysisSamples, setPAnalysisSamples] = useState("2048");
  const [pScanMode, setPScanMode] = useState("Desplazamiento 1b (máximo)");
  const [pKeyHex, setPKeyHex] = useState("");
  const [pWindowLen, setPWindowLen] = useState("256");
  const [pAuto2s, setPAuto2s] = useState(false);
  const [pPresetRestart, setPPresetRestart] = useState(true);
  const socketRef = useRef<Socket | null>(null);

  const apiBase = useMemo(() => {
    const fromEnv = (import.meta as any).env?.VITE_PI_SERVER_URL;
    if (fromEnv) return String(fromEnv);
    // When deployed, prefer same origin (server + web behind same host).
    if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
    return "http://localhost:9100";
  }, []);

  useEffect(() => {
    const s = io(apiBase, { transports: ["websocket", "polling"] });
    socketRef.current = s;
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("snapshot", (snap: { devices: Device[] }) => {
      const next: Record<string, Device> = {};
      for (const d of snap.devices || []) next[d.device_id] = d;
      setDevices(next);
    });
    s.on("device_state", ({ device_id, device }: { device_id: string; device: Device }) => {
      setDevices((prev) => ({ ...prev, [device_id]: device }));
    });
    s.on("device_telemetry", ({ device_id, device }: { device_id: string; device: Device }) => {
      setDevices((prev) => ({ ...prev, [device_id]: device }));
    });
    s.on("device_resp", (resp: any) => {
      setLastResp(resp);
    });
    return () => {
      s.close();
      socketRef.current = null;
    };
  }, [apiBase]);

  const list = useMemo(() => Object.values(devices).sort((a, b) => a.device_id.localeCompare(b.device_id)), [devices]);

  const sel = selected ? devices[selected] : null;

  const listFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((d) => {
      const online = Boolean(d.status?.online);
      if (filter === "online" && !online) return false;
      if (filter === "offline" && online) return false;
      if (!q) return true;
      return (
        d.device_id.toLowerCase().includes(q) ||
        String(d.telemetry?.name || "").toLowerCase().includes(q) ||
        String(d.telemetry?.location || "").toLowerCase().includes(q) ||
        String(d.status?.app?.active || "").toLowerCase().includes(q)
      );
    });
  }, [list, query, filter]);

  const stats = useMemo(() => {
    const total = list.length;
    const online = list.filter((d) => Boolean(d.status?.online)).length;
    const offline = total - online;
    return { total, online, offline };
  }, [list]);

  async function sendCmd(deviceId: string, cmd: string, args?: any) {
    setBusyCmd(`${deviceId}:${cmd}`);
    const r = await fetch(`${apiBase}/api/devices/${encodeURIComponent(deviceId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ? { cmd, args } : { cmd })
    });
    const j = await r.json();
    if (!j?.ok) throw new Error(j?.error || "Error sending command");
    setToast({ tone: "good", text: `Sent: ${cmd} → ${deviceId}` });
    return j;
  }

  return (
    <div className="min-h-screen">
      <div className="noise" />
      <div className="mx-auto max-w-7xl px-5 py-8">
        <div className="glass-strong shine rounded-3xl p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 ring-1 ring-accent/30">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path d="M7 7h10v10H7V7Z" stroke="currentColor" strokeWidth="1.5" className="text-text" />
                    <path d="M4 10V7a3 3 0 0 1 3-3h3" stroke="currentColor" strokeWidth="1.5" className="text-muted" />
                    <path d="M20 14v3a3 3 0 0 1-3 3h-3" stroke="currentColor" strokeWidth="1.5" className="text-muted" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-2xl font-semibold tracking-tight">Pi Dashboard</div>
                  <div className="mt-1 text-sm text-muted">
                    Remote MQTT (Mosquitto) control: real-time status, commands, and responses.
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="rounded-2xl border border-stroke bg-card/40 p-3">
                  <div className="text-xs text-muted">Total</div>
                  <div className="mt-1 text-xl font-semibold">{stats.total}</div>
                </div>
                <div className="rounded-2xl border border-stroke bg-card/40 p-3">
                  <div className="text-xs text-muted">Online</div>
                  <div className="mt-1 text-xl font-semibold text-good">{stats.online}</div>
                </div>
                <div className="rounded-2xl border border-stroke bg-card/40 p-3">
                  <div className="text-xs text-muted">Offline</div>
                  <div className="mt-1 text-xl font-semibold text-bad">{stats.offline}</div>
                </div>
              </div>
            </div>

            <div className="w-full max-w-md space-y-3">
              <div className="rounded-2xl border border-stroke bg-card/40 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted">Server</div>
                  <Chip tone={connected ? "good" : "bad"}>{connected ? "Connected" : "Disconnected"}</Chip>
                </div>
                <div className="mt-2 text-sm text-muted">{apiBase}</div>
              </div>

              <div className="flex gap-2">
                <input
                  className="input"
                  placeholder="Search by ID or app status…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select className="input w-40" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
                  <option value="all">All</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="glass-strong shine rounded-3xl p-5 lg:col-span-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Devices</div>
                <div className="mt-1 text-xs text-muted">Select a device to view details and run commands.</div>
              </div>
              <div className="text-xs text-muted">{listFiltered.length} visible</div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {listFiltered.map((d) => {
                const online = Boolean(d.status?.online);
                const appActive = d.status?.app?.active || "unknown";
                const isSel = selected === d.device_id;
                const tone: "good" | "bad" | "warn" | "muted" =
                  online ? (appActive.includes("active") ? "good" : "warn") : "bad";
                return (
                  <button
                    key={d.device_id}
                    onClick={() => setSelected(d.device_id)}
                    className={classNames(
                      "group rounded-2xl border p-4 text-left transition",
                      isSel ? "border-accent/60 bg-accent/10" : "border-stroke bg-card/35 hover:bg-white/5"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold">
                          {d.telemetry?.name ? `${d.telemetry.name} (${d.device_id})` : d.device_id}
                        </div>
                        {d.telemetry?.location ? (
                          <div className="mt-0.5 truncate text-xs text-muted">{d.telemetry.location}</div>
                        ) : null}
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Chip tone={online ? "good" : "bad"}>{online ? "online" : "offline"}</Chip>
                          <Chip tone={tone}>{appActive}</Chip>
                          <Chip tone="muted">seen {fmtAgeSeconds(d.status?.ts)}</Chip>
                        </div>
                      </div>
                      <div className={classNames("h-9 w-9 rounded-2xl ring-1 transition", isSel ? "bg-accent/20 ring-accent/30" : "bg-white/5 ring-white/10 group-hover:bg-white/10")}>
                        <div className="flex h-9 w-9 items-center justify-center">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-text">
                            <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <div className="rounded-xl bg-white/5 p-2">
                        <div className="text-[11px] text-muted">Uptime</div>
                        <div className="mt-0.5 text-sm font-semibold">{fmtUptime(d.status?.uptime_sec)}</div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-2">
                        <div className="text-[11px] text-muted">Service</div>
                        <div className="mt-0.5 truncate text-sm font-semibold">{d.status?.app?.service || "—"}</div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-2">
                        <div className="text-[11px] text-muted">Reason</div>
                        <div className="mt-0.5 truncate text-sm font-semibold">{d.status?.reason || "—"}</div>
                      </div>
                    </div>
                  </button>
                );
              })}

              {listFiltered.length === 0 ? (
                <div className="sm:col-span-2 rounded-2xl border border-stroke bg-card/35 p-6 text-sm text-muted">
                  No visible devices yet. Waiting for <code className="rounded bg-white/5 px-1.5 py-0.5">dt/&lt;id&gt;/status</code> from MQTT.
                </div>
              ) : null}
            </div>
          </div>

          <div className="glass-strong shine rounded-3xl p-5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Control</div>
              {sel ? <Chip tone={sel.status?.online ? "good" : "bad"}>{sel.status?.online ? "Online" : "Offline"}</Chip> : <Chip tone="muted">No selection</Chip>}
            </div>
            {!sel ? (
              <div className="mt-3 text-sm text-muted">Select a device to view actions.</div>
            ) : (
              <>
                <div className="mt-4 rounded-2xl border border-stroke bg-card/35 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-muted">Device</div>
                      <div className="mt-1 truncate text-lg font-semibold">{sel.telemetry?.name ? `${sel.telemetry.name} (${sel.device_id})` : sel.device_id}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Chip tone={sel.status?.online ? "good" : "bad"}>{sel.status?.online ? "online" : "offline"}</Chip>
                        <Chip tone="muted">last hb {fmtAgeSeconds(sel.status?.ts)}</Chip>
                        <Chip tone="muted">uptime {fmtUptime(sel.status?.uptime_sec)}</Chip>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-stroke bg-white/5 p-3">
                      <div className="text-xs text-muted">App</div>
                      <div className="mt-1 text-sm font-semibold">{sel.status?.app?.active ?? "—"}</div>
                      <div className="mt-1 max-w-[220px] truncate text-xs text-muted">{sel.status?.app?.service ?? ""}</div>
                      <div className="mt-2 text-xs text-muted">
                        enabled: {sel.status?.app?.enabled ?? "—"}
                        {sel.status?.app && (sel.status.app as any).mode ? ` • mode: ${(sel.status.app as any).mode}` : ""}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    className="btn btn-primary"
                    disabled={busyCmd === `${sel.device_id}:ping`}
                    onClick={async () => {
                      try {
                        await sendCmd(sel.device_id, "ping");
                      } catch (e: any) {
                        setToast({ tone: "bad", text: String(e?.message || e) });
                      } finally {
                        setBusyCmd(null);
                      }
                    }}
                  >
                    {busyCmd === `${sel.device_id}:ping` ? "Sending…" : "Ping"}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busyCmd === `${sel.device_id}:app.status`}
                    onClick={async () => {
                      try {
                        await sendCmd(sel.device_id, "app.status");
                      } catch (e: any) {
                        setToast({ tone: "bad", text: String(e?.message || e) });
                      } finally {
                        setBusyCmd(null);
                      }
                    }}
                  >
                    {busyCmd === `${sel.device_id}:app.status` ? "Sending…" : "Status"}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busyCmd === `${sel.device_id}:app.start`}
                    onClick={async () => {
                      try {
                        await sendCmd(sel.device_id, "app.start");
                      } catch (e: any) {
                        setToast({ tone: "bad", text: String(e?.message || e) });
                      } finally {
                        setBusyCmd(null);
                      }
                    }}
                  >
                    {busyCmd === `${sel.device_id}:app.start` ? "Sending…" : "Start"}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busyCmd === `${sel.device_id}:app.stop`}
                    onClick={async () => {
                      try {
                        await sendCmd(sel.device_id, "app.stop");
                      } catch (e: any) {
                        setToast({ tone: "bad", text: String(e?.message || e) });
                      } finally {
                        setBusyCmd(null);
                      }
                    }}
                  >
                    {busyCmd === `${sel.device_id}:app.stop` ? "Sending…" : "Stop"}
                  </button>
                  <button
                    className="btn btn-danger col-span-2"
                    disabled={busyCmd === `${sel.device_id}:app.restart`}
                    onClick={async () => {
                      try {
                        await sendCmd(sel.device_id, "app.restart");
                      } catch (e: any) {
                        setToast({ tone: "bad", text: String(e?.message || e) });
                      } finally {
                        setBusyCmd(null);
                      }
                    }}
                  >
                    {busyCmd === `${sel.device_id}:app.restart` ? "Sending…" : "Restart app"}
                  </button>
                </div>

                <div className="mt-4 rounded-2xl border border-stroke bg-card/35 p-4">
                  <div className="text-xs font-semibold text-muted">Update (ZIP)</div>
                  {busyCmd && sel ? (
                    busyCmd === `${sel.device_id}:app.update` || busyCmd === `${sel.device_id}:app.update.check` ? (
                      <div className="mt-2 flex items-center gap-2 rounded-2xl border border-stroke bg-white/5 px-3 py-2 text-xs text-muted">
                        <span
                          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white/70"
                          aria-hidden="true"
                        />
                        <span className="font-semibold text-text">
                          {busyCmd === `${sel.device_id}:app.update.check` ? "Checking update…" : "Updating…"}
                        </span>
                        <span>Please do not close or click again.</span>
                      </div>
                    ) : null
                  ) : null}
                  <div className="mt-2 grid grid-cols-1 gap-2">
                    <input
                      className="input"
                      placeholder="Version (ej: v1.2.3 o 2026-04-15)"
                      value={updateVersion}
                      onChange={(e) => setUpdateVersion(e.target.value)}
                      disabled={
                        Boolean(sel) &&
                        (busyCmd === `${sel.device_id}:app.update` || busyCmd === `${sel.device_id}:app.update.check`)
                      }
                    />
                    <input
                      className="input"
                      placeholder="ZIP URL (https://...)"
                      value={updateUrl}
                      onChange={(e) => setUpdateUrl(e.target.value)}
                      disabled={
                        Boolean(sel) &&
                        (busyCmd === `${sel.device_id}:app.update` || busyCmd === `${sel.device_id}:app.update.check`)
                      }
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        className="btn btn-ghost"
                        disabled={busyCmd === `${sel.device_id}:app.update.check`}
                        onClick={async () => {
                          try {
                            const version = updateVersion.trim();
                            const url = updateUrl.trim();
                            if (!version || !url) throw new Error("Version and URL are required");
                            await sendCmd(sel.device_id, "app.update.check", { version, url });
                          } catch (e: any) {
                            setToast({ tone: "bad", text: String(e?.message || e) });
                          } finally {
                            setBusyCmd(null);
                          }
                        }}
                      >
                        {busyCmd === `${sel.device_id}:app.update.check` ? "Checking…" : "Check"}
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={busyCmd === `${sel.device_id}:app.update`}
                        onClick={async () => {
                          try {
                            const version = updateVersion.trim();
                            const url = updateUrl.trim();
                            if (!version || !url) throw new Error("Version and URL are required");
                            await sendCmd(sel.device_id, "app.update", { version, url });
                          } catch (e: any) {
                            setToast({ tone: "bad", text: String(e?.message || e) });
                          } finally {
                            setBusyCmd(null);
                          }
                        }}
                      >
                        {busyCmd === `${sel.device_id}:app.update` ? "Updating…" : "Update"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted">
                    <span className="font-semibold">Check</span>: validates download/zip/deps without activating.{" "}
                    <span className="font-semibold">Update</span>: downloads ZIP → installs deps → swaps{" "}
                    <code className="rounded bg-white/5 px-1 py-0.5">/opt/h2train-app/current</code> → restart.
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-stroke bg-card/35 p-4">
                  <div className="text-xs font-semibold text-muted">Remote config</div>
                  <div className="mt-2 grid grid-cols-1 gap-2">
                    <input
                      className="input"
                      placeholder="KEY (e.g. MQTT_HOST or API_URL)"
                      value={cfgKey}
                      onChange={(e) => setCfgKey(e.target.value)}
                      disabled={
                        Boolean(sel) && (busyCmd === `${sel.device_id}:app.config.set`)
                      }
                    />
                    <input
                      className="input"
                      placeholder="VALUE (e.g. mqtt.luxops.es)"
                      value={cfgValue}
                      onChange={(e) => setCfgValue(e.target.value)}
                      disabled={
                        Boolean(sel) && (busyCmd === `${sel.device_id}:app.config.set`)
                      }
                    />
                    <label className="flex items-center gap-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={cfgRestart}
                        onChange={(e) => setCfgRestart(e.target.checked)}
                        disabled={Boolean(sel) && (busyCmd === `${sel.device_id}:app.config.set`)}
                      />
                      Restart app after applying
                    </label>
                    <button
                      className="btn btn-primary"
                      disabled={busyCmd === `${sel.device_id}:app.config.set`}
                      onClick={async () => {
                        try {
                          const key = cfgKey.trim();
                          if (!key) throw new Error("KEY is required");
                          // Empty VALUE is allowed (to set an empty string).
                          const value = cfgValue;
                          await sendCmd(sel.device_id, "app.config.set", { env: { [key]: value }, restart: cfgRestart });
                          setCfgKey("");
                          setCfgValue("");
                        } catch (e: any) {
                          setToast({ tone: "bad", text: String(e?.message || e) });
                        } finally {
                          setBusyCmd(null);
                        }
                      }}
                    >
                      {busyCmd === `${sel.device_id}:app.config.set` ? "Applying…" : "Apply"}
                    </button>
                  </div>
                  <div className="mt-2 text-xs text-muted">
                    Sends <code className="rounded bg-white/5 px-1 py-0.5">app.config.set</code> to the device agent.
                    You can apply one parameter at a time (fast and safe).
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-stroke bg-card/35 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-muted">Signal / Key (runtime)</div>
                    <div className="flex gap-2">
                      <button
                        className="btn btn-ghost"
                        disabled={busyCmd === `${sel.device_id}:app.snapshot`}
                        onClick={async () => {
                          try {
                            await sendCmd(sel.device_id, "app.snapshot");
                          } catch (e: any) {
                            setToast({ tone: "bad", text: String(e?.message || e) });
                          } finally {
                            setBusyCmd(null);
                          }
                        }}
                      >
                        {busyCmd === `${sel.device_id}:app.snapshot` ? "Requesting…" : "Snapshot"}
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={busyCmd === `${sel.device_id}:app.stream.set`}
                        onClick={async () => {
                          try {
                            const streamEnabled = Boolean((sel.telemetry as any)?.app_stream?.enabled);
                            const enabled = !streamEnabled;
                            await sendCmd(sel.device_id, "app.stream.set", { enabled, interval_sec: 0.1 });
                          } catch (e: any) {
                            setToast({ tone: "bad", text: String(e?.message || e) });
                          } finally {
                            setBusyCmd(null);
                          }
                        }}
                      >
                        {busyCmd === `${sel.device_id}:app.stream.set`
                          ? "Switching…"
                          : Boolean((sel.telemetry as any)?.app_stream?.enabled)
                            ? "Stop stream"
                            : "Start stream"}
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 text-xs text-muted">
                    {(() => {
                      const t: any = sel.telemetry as any;
                      const keyHex = t?.app_key?.key_hex || t?.app_runtime?.key_hex || "";
                      const entropyLabel = t?.app_key?.entropy_label || t?.app_runtime?.entropy_label || "";
                      const keySeq = t?.app_key?.key_seq;
                      const ageMs = t?.app_key?.age_ms;
                      if (!keyHex) return null;
                      return (
                      <>
                        <div className="font-semibold text-text">Key (hex):</div>
                        <div className="mt-1 break-all rounded-xl bg-white/5 p-2 text-[11px] text-text">
                          {String(keyHex)}
                        </div>
                        {entropyLabel ? <div className="mt-2">{String(entropyLabel)}</div> : null}
                        {keySeq !== undefined || ageMs !== undefined ? (
                          <div className="mt-1 text-[11px] text-muted">
                            seq={String(keySeq ?? "—")} • age_ms={String(ageMs ?? "—")}
                          </div>
                        ) : null}
                      </>
                      );
                    })() || "Press Snapshot or enable Stream to view key/signal."}
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-stroke bg-card/35 p-4">
                  <div className="text-xs font-semibold text-muted">Parser / TD8-ECG (presets)</div>
                  <div className="mt-2 grid grid-cols-1 gap-2">
                    <div className="grid grid-cols-2 gap-2">
                      <select className="input" value={pRaw17Endian} onChange={(e) => setPRaw17Endian(e.target.value as any)}>
                        <option value="big">RAW17 endian: big</option>
                        <option value="little">RAW17 endian: little</option>
                      </select>
                      <label className="flex items-center gap-2 rounded-2xl border border-stroke bg-white/5 px-3 py-2 text-xs text-muted">
                        <input type="checkbox" checked={pRaw17Signed} onChange={(e) => setPRaw17Signed(e.target.checked)} />
                        RAW17 signed int24
                      </label>
                    </div>

                    <select className="input" value={pPipeline} onChange={(e) => setPPipeline(e.target.value)}>
                      <option value="RNS+HKDF (actual)">Pipeline: RNS+HKDF (current)</option>
                      <option value="Acumulativo 11 bits/muestra">Pipeline: Cumulative 11-bit/sample</option>
                    </select>

                    <select className="input" value={pEcgSource} onChange={(e) => setPEcgSource(e.target.value)}>
                      <option value="ECG 3bx en vivo">ECG source: Live ECG 3bx</option>
                      <option value="ECG sintético (función)">ECG source: Synthetic ECG (function)</option>
                    </select>

                    <div className="grid grid-cols-2 gap-2">
                      <input className="input" value={pEntropyThr} onChange={(e) => setPEntropyThr(e.target.value)} placeholder="Entropy threshold (e.g. 0.85)" />
                      <input className="input" value={pAnalysisSamples} onChange={(e) => setPAnalysisSamples(e.target.value)} placeholder="Joint analysis (samples)" />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <select className="input" value={pInvalidPolicy} onChange={(e) => setPInvalidPolicy(e.target.value)}>
                        <option value="Descartar no válidas">Invalid keys: Discard</option>
                        <option value="Guardar para recombinar">Invalid keys: Keep for recombination</option>
                      </select>
                      <select className="input" value={pRecombine} onChange={(e) => setPRecombine(e.target.value)}>
                        <option value="Mitad + mitad">Recombination: Half + half</option>
                        <option value="Alternar bits">Recombination: Alternate bits</option>
                        <option value="XOR + SHA256">Recombination: XOR + SHA256</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <input className="input" value={pMaxInvalidPool} onChange={(e) => setPMaxInvalidPool(e.target.value)} placeholder="Invalid pool (max)" />
                      <select className="input" value={pScanMode} onChange={(e) => setPScanMode(e.target.value)}>
                        <option value="No solapado (128b)">Scan: Non-overlapping (128b)</option>
                        <option value="Desplazamiento 11b">Scan: Shift 11b</option>
                        <option value="Desplazamiento 1b (máximo)">Scan: Shift 1b (max)</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <input className="input" value={pWindowLen} onChange={(e) => setPWindowLen(e.target.value)} placeholder="Window (flow) (e.g. 256)" />
                      <label className="flex items-center gap-2 rounded-2xl border border-stroke bg-white/5 px-3 py-2 text-xs text-muted">
                        <input type="checkbox" checked={pKeepTailBits} onChange={(e) => setPKeepTailBits(e.target.checked)} />
                        Keep leftover bits
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex items-center gap-2 rounded-2xl border border-stroke bg-white/5 px-3 py-2 text-xs text-muted">
                        <input type="checkbox" checked={pAuto2s} onChange={(e) => setPAuto2s(e.target.checked)} />
                        Auto every 2s (flow)
                      </label>
                      <input className="input" value={pKeyHex} onChange={(e) => setPKeyHex(e.target.value)} placeholder="128b key hex (optional)" />
                    </div>

                    <label className="flex items-center gap-2 text-xs text-muted">
                      <input type="checkbox" checked={pPresetRestart} onChange={(e) => setPPresetRestart(e.target.checked)} />
                      Restart app after applying presets
                    </label>

                    <button
                      className="btn btn-primary"
                      disabled={busyCmd === `${sel.device_id}:app.config.set`}
                      onClick={async () => {
                        try {
                          const env: Record<string, string> = {
                            H2T_UART_RAW17_ENDIAN: pRaw17Endian,
                            H2T_UART_RAW17_SIGNED_INT24: pRaw17Signed ? "1" : "0",
                            H2T_TD8_PIPELINE: pPipeline,
                            H2T_TD8_ECG_SOURCE: pEcgSource,
                            H2T_TD8_ENTROPY_THRESHOLD: pEntropyThr.trim(),
                            H2T_TD8_INVALID_POLICY: pInvalidPolicy,
                            H2T_TD8_RECOMBINE_STRATEGY: pRecombine,
                            H2T_TD8_MAX_INVALID_POOL: pMaxInvalidPool.trim(),
                            H2T_TD8_KEEP_TAIL_BITS: pKeepTailBits ? "1" : "0",
                            H2T_TD8_ANALYSIS_WINDOW_SAMPLES: pAnalysisSamples.trim(),
                            H2T_TD8_SCAN_MODE: pScanMode,
                            H2T_TD8_KEY_128_HEX: pKeyHex.trim(),
                            H2T_TD8_WINDOW_LEN: pWindowLen.trim(),
                            H2T_TD8_AUTO_EVERY_2S: pAuto2s ? "1" : "0"
                          };
                          await sendCmd(sel.device_id, "app.config.set", { env, restart: pPresetRestart });
                          setToast({
                            tone: "good",
                            text: pPresetRestart
                              ? "Config applied (parser/TD8). Restarting app…"
                              : "Config applied (parser/TD8). Restart disabled."
                          });
                        } catch (e: any) {
                          setToast({ tone: "bad", text: String(e?.message || e) });
                        } finally {
                          setBusyCmd(null);
                        }
                      }}
                    >
                      Apply presets
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={busyCmd === `${sel.device_id}:app.config.get`}
                      onClick={async () => {
                        try {
                          await sendCmd(sel.device_id, "app.config.get");
                        } catch (e: any) {
                          setToast({ tone: "bad", text: String(e?.message || e) });
                        } finally {
                          setBusyCmd(null);
                        }
                      }}
                    >
                      {busyCmd === `${sel.device_id}:app.config.get` ? "Reading…" : "Read config"}
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={busyCmd === `${sel.device_id}:app.env.get`}
                      onClick={async () => {
                        try {
                          await sendCmd(sel.device_id, "app.env.get");
                        } catch (e: any) {
                          setToast({ tone: "bad", text: String(e?.message || e) });
                        } finally {
                          setBusyCmd(null);
                        }
                      }}
                    >
                      {busyCmd === `${sel.device_id}:app.env.get` ? "Reading…" : "Read env (runtime)"}
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={busyCmd === `${sel.device_id}:app.code.get`}
                      onClick={async () => {
                        try {
                          await sendCmd(sel.device_id, "app.code.get");
                        } catch (e: any) {
                          setToast({ tone: "bad", text: String(e?.message || e) });
                        } finally {
                          setBusyCmd(null);
                        }
                      }}
                    >
                      {busyCmd === `${sel.device_id}:app.code.get` ? "Reading…" : "Read app.py (version)"}
                    </button>
                  </div>
                  <div className="mt-2 text-xs text-muted">
                    This writes <code className="rounded bg-white/5 px-1 py-0.5">H2T_*</code> variables into the device .env file.
                  </div>
                </div>
              </>
            )}

            <div className="mt-4">
              <div className="text-xs font-semibold text-muted">Last response</div>
              <pre className="mt-2 max-h-64 overflow-auto rounded-2xl border border-stroke bg-card/35 p-3 text-xs text-muted">
                {lastResp ? JSON.stringify(lastResp, null, 2) : "—"}
              </pre>
            </div>
          </div>
        </div>
      </div>

      {toast ? (
        <div className="fixed bottom-5 right-5 z-50">
          <div
            className={classNames(
              "glass-strong rounded-2xl px-4 py-3 text-sm shadow-2xl",
              toast.tone === "good" ? "border-good/30" : toast.tone === "bad" ? "border-bad/30" : "border-white/10"
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-muted">Notification</div>
                <div className={classNames("mt-1 font-semibold", toast.tone === "good" ? "text-good" : toast.tone === "bad" ? "text-bad" : "text-text")}>
                  {toast.text}
                </div>
              </div>
              <button
                className="btn btn-ghost px-2 py-1 text-xs"
                onClick={() => setToast(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

