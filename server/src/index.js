import dotenv from "dotenv";
// Load env explicitly from Pi-Dashboard/server/.env (concurrently/workspaces may run with a different cwd).
dotenv.config({ path: new URL("../.env", import.meta.url) });
import dns from "dns";
import net from "net";
import express from "express";
import cors from "cors";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import mqtt from "mqtt";
import { nanoid } from "nanoid";

// Render/most PaaS set PORT. Keep PI_DASHBOARD_PORT for local dev.
const PORT = Number(process.env.PORT || process.env.PI_DASHBOARD_PORT || 9100);
// Cloudflare Tunnel (Mosquitto WS) example:
// MQTT_URL="wss://mqtt.luxops.es"
const MQTT_URL = String(process.env.MQTT_URL || "wss://mqtt.luxops.es").trim();
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const BASE_TOPIC = process.env.BASE_TOPIC || "dt";
// Mosquitto websockets commonly use "/mqtt".
const MQTT_WS_PATH = String(process.env.MQTT_WS_PATH || "/mqtt").trim() || "/mqtt";
const DEBUG_TELEMETRY = String(process.env.DEBUG_TELEMETRY || "").trim() === "1";
const DEBUG_TELEMETRY_DEVICE = String(process.env.DEBUG_TELEMETRY_DEVICE || "").trim();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

/** @type {Map<string, any>} */
const devices = new Map();

// NOTE: We intentionally avoid server-side snapshot polling.
// Polling is initiated from the web UI (client-side) so opening the web page
// never triggers background commands and we can suppress "last response" noise.

function upsertDevice(deviceId, patch) {
  const cur = devices.get(deviceId) || { device_id: deviceId };
  const next = { ...cur, ...patch };
  devices.set(deviceId, next);
  return next;
}

function _shouldDebugDevice(deviceId) {
  if (!DEBUG_TELEMETRY) return false;
  if (!DEBUG_TELEMETRY_DEVICE) return true;
  return String(deviceId) === DEBUG_TELEMETRY_DEVICE;
}

function _shortHex(h) {
  const s = typeof h === "string" ? h : "";
  if (!s) return "";
  return s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function isOnline(d) {
  if (!d?.status) return false;
  return Boolean(d.status.online);
}

// Prefer IPv4 on dual-stack networks; helps when IPv6 is broken/misconfigured.
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // ignore (older Node)
}

function _mqttHostForLog() {
  try {
    const u = new URL(MQTT_URL);
    return u.host;
  } catch {
    return MQTT_URL;
  }
}

function _isPrivateIPv6(addr) {
  // ULA fd00::/8 (includes fd10::)
  return typeof addr === "string" && addr.toLowerCase().startsWith("fd");
}

function _lookupPreferV4(hostname, _opts, cb) {
  // mqtt.js -> ws -> http(s).request uses lookup() if provided.
  // Some callers may pass { all: true } and then expect an array return signature.
  const opts = _opts && typeof _opts === "object" ? _opts : {};

  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [];

    /** @type {Array<{address: string, family: 4|6}>} */
    const normalized = list
      .map((a) => {
        if (typeof a === "string") {
          const fam = net.isIP(a);
          return fam ? { address: a, family: fam } : null;
        }
        if (a && typeof a === "object" && typeof a.address === "string") {
          const fam = a.family || net.isIP(a.address);
          return fam ? { address: a.address, family: fam } : null;
        }
        return null;
      })
      .filter(Boolean);

    const v4 = normalized.find((a) => a.family === 4);
    const v6Public = normalized.find((a) => a.family === 6 && !_isPrivateIPv6(a.address));
    const v6Any = normalized.find((a) => a.family === 6);

    // If caller asked for all addresses, return an array (prefer v4 first).
    if (opts.all) {
      const ordered = [
        ...(v4 ? [v4] : []),
        ...normalized.filter((a) => a !== v4 && a.family === 4),
        ...(v6Public ? [v6Public] : []),
        ...normalized.filter((a) => a !== v6Public && a.family === 6 && !_isPrivateIPv6(a.address)),
      ];

      if (!ordered.length && v6Any?.address && _isPrivateIPv6(v6Any.address)) {
        return cb(
          new Error(
            `DNS for ${hostname} resolved only to private IPv6 (${v6Any.address}). Enable Cloudflare proxy (orange cloud) for the CNAME record.`
          )
        );
      }
      if (!ordered.length) return cb(new Error(`DNS lookup returned no usable addresses for ${hostname}`));
      return cb(null, ordered);
    }

    // Otherwise return a single address.
    if (v4?.address) return cb(null, v4.address, 4);
    if (v6Public?.address) return cb(null, v6Public.address, 6);

    if (v6Any?.address && _isPrivateIPv6(v6Any.address)) {
      return cb(
        new Error(
          `DNS for ${hostname} resolved only to private IPv6 (${v6Any.address}). Enable Cloudflare proxy (orange cloud) for the CNAME record.`
        )
      );
    }
    return cb(new Error(`DNS lookup returned no usable addresses for ${hostname}`));
  });
}

const mqttClient = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME || undefined,
  password: MQTT_PASSWORD || undefined,
  reconnectPeriod: 1500,
  // Ensure WSS connect doesn't use broken IPv6 ULA resolutions.
  wsOptions: {
    lookup: _lookupPreferV4,
    family: 4,
    path: MQTT_WS_PATH,
  },
});

mqttClient.on("connect", () => {
  // eslint-disable-next-line no-console
  console.log(
    `[pi-dashboard] mqtt connected: ${MQTT_URL} (host=${_mqttHostForLog()} path=${MQTT_WS_PATH} base=${BASE_TOPIC})`
  );
  // Agent topics:
  // - dt/<device_id>/status (retained + LWT)
  // - dt/<device_id>/telemetry (retained)
  // - dt/<device_id>/ack/<req_id>
  mqttClient.subscribe(`${BASE_TOPIC}/+/status`, { qos: 1 });
  mqttClient.subscribe(`${BASE_TOPIC}/+/telemetry`, { qos: 1 });
  mqttClient.subscribe(`${BASE_TOPIC}/+/ack/+`, { qos: 1 });
});

mqttClient.on("reconnect", () => {
  // eslint-disable-next-line no-console
  console.log("[pi-dashboard] mqtt reconnecting...");
});

mqttClient.on("close", () => {
  // eslint-disable-next-line no-console
  console.log("[pi-dashboard] mqtt closed");
});

mqttClient.on("packetreceive", (packet) => {
  if (packet?.cmd === "connack") {
    // eslint-disable-next-line no-console
    console.log("[pi-dashboard] mqtt connack:", packet);
  }
});

mqttClient.on("offline", () => {
  // eslint-disable-next-line no-console
  console.log("[pi-dashboard] mqtt offline");
});

mqttClient.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[pi-dashboard] mqtt error:", err?.message || err, `(host=${_mqttHostForLog()})`);
});

mqttClient.on("message", (topic, payloadBuf) => {
  const payloadStr = payloadBuf.toString("utf-8");
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return;
  }

  const parts = topic.split("/");
  if (parts.length < 3) return;
  const [base, deviceId, kind] = parts;
  if (base !== BASE_TOPIC) return;

  if (kind === "status") {
    const d = upsertDevice(deviceId, {
      last_seen_ts: payload.ts || Date.now() / 1000,
      status: payload,
    });
    io.emit("device_state", { device_id: deviceId, device: d });
    return;
  }

  if (kind === "telemetry") {
    const prev = devices.get(deviceId) || { device_id: deviceId };
    const prevTel = prev.telemetry && typeof prev.telemetry === "object" ? prev.telemetry : {};
    const nextTel = payload && typeof payload === "object" ? payload : {};
    // Merge telemetry so partial updates don't wipe prior fields.
    // IMPORTANT: keep last good app_key unless we receive a new one with key_hex.
    const merged = { ...prevTel, ...nextTel };
    try {
      const prevKey = prevTel?.app_key;
      const nextKey = nextTel?.app_key;
      const prevHex = typeof prevKey?.key_hex === "string" ? prevKey.key_hex : "";
      const nextHex = typeof nextKey?.key_hex === "string" ? nextKey.key_hex : "";
      // If incoming app_key is missing/empty, keep previous app_key (avoid clobbering with ok:false or partial payloads).
      if (prevKey && (!nextKey || !nextHex)) {
        merged.app_key = prevKey;
      }
      // If we kept/received a key, track when we last saw it (server-side).
      const useHex = nextHex || prevHex;
      if (useHex) {
        merged.app_key_meta = {
          key_hex: useHex,
          last_seen_ts: (payload && payload.ts) ? payload.ts : Date.now() / 1000,
        };
      }
    } catch {
      // ignore
    }
    const d = upsertDevice(deviceId, {
      last_seen_ts: payload.ts || Date.now() / 1000,
      telemetry: merged,
    });
    if (_shouldDebugDevice(deviceId)) {
      try {
        const recvTs = Date.now() / 1000;
        const appKeyHex = merged?.app_key?.key_hex || merged?.app_runtime?.key_hex || "";
        const appKeySeq = merged?.app_key?.key_seq;
        const appStream = merged?.app_stream?.enabled;
        const srcTs = typeof payload.ts === "number" ? payload.ts : null;
        const lagMs = srcTs ? Math.round((recvTs - srcTs) * 1000) : null;
        // eslint-disable-next-line no-console
        console.log(
          `[pi-dashboard][telemetry] dev=${deviceId} recv=${recvTs.toFixed(3)} src=${srcTs?.toFixed?.(3) ?? "—"} lag_ms=${lagMs ?? "—"} stream=${String(appStream)} seq=${appKeySeq ?? "—"} key=${_shortHex(appKeyHex)}`
        );
      } catch {
        // ignore
      }
    }
    io.emit("device_telemetry", { device_id: deviceId, device: d });
    return;
  }

  if (kind === "ack") {
    const reqId = parts[3] || "noid";
    if (_shouldDebugDevice(deviceId)) {
      try {
        const recvTs = Date.now() / 1000;
        const srcTs = typeof payload?.ts === "number" ? payload.ts : null;
        const lagMs = srcTs ? Math.round((recvTs - srcTs) * 1000) : null;
        // eslint-disable-next-line no-console
        console.log(
          `[pi-dashboard][ack] dev=${deviceId} req=${reqId} recv=${recvTs.toFixed(3)} src=${srcTs?.toFixed?.(3) ?? "—"} lag_ms=${lagMs ?? "—"} ok=${String(Boolean(payload?.ok))} cmd=${String(payload?.cmd || "")}`
        );
      } catch {
        // ignore
      }
    }
    io.emit("device_resp", { device_id: deviceId, req_id: reqId, payload });
    return;
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mqtt: mqttClient.connected, devices: devices.size });
});

app.get("/api/devices", (_req, res) => {
  const list = Array.from(devices.values()).map((d) => ({
    device_id: d.device_id,
    online: isOnline(d),
    last_seen_ts: d.last_seen_ts || null,
    status: d.status || null,
    telemetry: d.telemetry || null,
  }));
  res.json({ ok: true, devices: list });
});

app.get("/api/debug/device/:deviceId", (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const d = devices.get(deviceId);
  if (!d) return res.status(404).json({ ok: false, error: "device not found" });
  const now = Date.now() / 1000;
  const srcTs = d?.telemetry?.ts;
  const lagMs = typeof srcTs === "number" ? Math.round((now - srcTs) * 1000) : null;
  res.json({
    ok: true,
    device_id: deviceId,
    server_ts: now,
    lag_ms: lagMs,
    status: d.status || null,
    telemetry: d.telemetry || null,
  });
});

app.post("/api/devices/:deviceId/command", (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const cmd = String(req.body?.cmd || "").trim();
  const id = String(req.body?.id || nanoid()).trim();
  const args = req.body?.args;
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId requerido" });
  if (!cmd) return res.status(400).json({ ok: false, error: "cmd requerido" });

  const topic = `${BASE_TOPIC}/${deviceId}/cmd`;
  const payloadObj = { id, cmd };
  if (args && typeof args === "object") payloadObj.args = args;
  const payload = JSON.stringify(payloadObj);
  const qos = cmd === "app.snapshot" ? 0 : 1;
  mqttClient.publish(topic, payload, { qos, retain: false }, (err) => {
    if (err) return res.status(500).json({ ok: false, error: String(err) });
    res.json({ ok: true, id, device_id: deviceId, cmd });
  });
});

io.on("connection", (socket) => {
  socket.emit("snapshot", {
    devices: Array.from(devices.values()),
    baseTopic: BASE_TOPIC,
    mqttUrl: MQTT_URL,
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[pi-dashboard] server listening on http://0.0.0.0:${PORT}`);
});

