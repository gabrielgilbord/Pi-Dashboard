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
// mqtt.js defaults WS path to "/mqtt"; Mosquitto commonly listens on "/".
const MQTT_WS_PATH = String(process.env.MQTT_WS_PATH || "/").trim() || "/";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

/** @type {Map<string, any>} */
const devices = new Map();

function upsertDevice(deviceId, patch) {
  const cur = devices.get(deviceId) || { device_id: deviceId };
  const next = { ...cur, ...patch };
  devices.set(deviceId, next);
  return next;
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
  // We hard-prefer A records; only fall back to AAAA if it's not ULA.
  dns.resolve4(hostname, (e4, a4) => {
    if (!e4 && a4 && a4.length) return cb(null, a4[0], 4);
    dns.resolve6(hostname, (e6, a6) => {
      const usable = (a6 || []).find((ip) => net.isIP(ip) === 6 && !_isPrivateIPv6(ip));
      if (!e6 && usable) return cb(null, usable, 6);
      cb(e4 || e6 || new Error(`DNS lookup failed for ${hostname}`));
    });
  });
}

const mqttClient = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME || undefined,
  password: MQTT_PASSWORD || undefined,
  reconnectPeriod: 1500,
  // Ensure WSS connect doesn't use broken IPv6 ULA resolutions.
  wsOptions: {
    lookup: _lookupPreferV4,
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
    const d = upsertDevice(deviceId, {
      last_seen_ts: payload.ts || Date.now() / 1000,
      telemetry: payload,
    });
    io.emit("device_telemetry", { device_id: deviceId, device: d });
    return;
  }

  if (kind === "ack") {
    const reqId = parts[3] || "noid";
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
  mqttClient.publish(topic, payload, { qos: 1, retain: false }, (err) => {
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

