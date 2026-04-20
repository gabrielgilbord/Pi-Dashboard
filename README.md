## Pi-Dashboard (nuevo)

Dashboard web para controlar Raspberry Pi mediante MQTT (Mosquitto).

### Componentes

- **Agente en cada Pi**: `pi-mqtt-agent/` (publica estado y recibe comandos)
- **Servidor dashboard**: `Pi-Dashboard/server/` (se conecta al broker MQTT y expone API + WebSocket)
- **Frontend**: `Pi-Dashboard/web/` (UI para ver y controlar dispositivos)

### MQTT (convención)

- Telemetría (retained): `dt/<device_id>/telemetry`
- Estado (retained + LWT): `dt/<device_id>/status`
- Comandos: `dt/<device_id>/cmd`
- Respuestas/ack: `dt/<device_id>/ack/<request_id>`

Payload comando (JSON):
```json
{ "id": "uuid-opcional", "cmd": "app.restart" }
```

Comandos soportados por el agente:
- `ping`
- `app.status`
- `app.start`
- `app.stop`
- `app.restart`
- `agent.restart`

### Cloudflare Tunnel (recomendado)

URL recomendada (hostname fijo): `wss://mqtt.luxops.es`

Configura el server con variables:

- `MQTT_URL="wss://mqtt.luxops.es"`
- `MQTT_USERNAME="dashboard"`
- `MQTT_PASSWORD="..."`
- `BASE_TOPIC="dt"`

