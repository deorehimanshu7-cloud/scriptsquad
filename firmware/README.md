# AGRIFUR2 ESP32 Firmware (reference)

Status: **CODE IMPLEMENTED — NOT PHYSICALLY TESTED** (no ESP32 hardware or
MQTT broker was available in the verification sandbox → `HARDWARE_NOT_CONNECTED`).

## What it does

- Samples wired sensors (only genuinely attached hardware — readings are
  never synthesized; un-wired sensor types are omitted).
- Publishes versioned telemetry to
  `agrifur/v1/devices/{deviceId}/telemetry` (QoS 1) and heartbeats to
  `/heartbeat`.
- Offline buffering: if the broker is unreachable, each batch is appended to a
  LittleFS journal (`/journal.ndjson`) with a stable `message_id` + sequence;
  on reconnect the journal is replayed. The backend dedupes by
  `(device_id, message_id)`, so replays never duplicate observations
  (verified by integration tests on the server side).
- Downlink commands (whitelist): `set_sampling_interval`, `sync_time`,
  `request_sensor_reading`, `request_device_status`, `sync_device`,
  `firmware_update_check` — acknowledged on `/responses`.
- **No actuator commands by default.** Irrigation/valve/restart control is
  intentionally omitted; the backend rejects actuator commands unless
  `AGRIFUR2_ENABLE_ACTUATORS=true` and an explicit authorization policy exists.

## Security model

- Only the per-device key lives in `secrets.h` (issued once by
  `POST /api/devices/register`).
- NEVER put backend JWT secrets, database credentials or LLM API keys in the
  firmware.
- Use MQTT over TLS (`mqtts://…:8883`) in production; store the broker CA in
  LittleFS (`/ca.pem`) instead of the binary when possible.
- The ESP32 never runs the AGRIFUR LLM — it handles audio/offline cache in the
  voice variant; language, tools and reasoning always run on the backend.

## Voice variant (edge voice device)

The same device pattern applies: register as
`POST /api/voice-devices/register` (type `voice_assistant`). While online the
ESP32 streams/question-answers through the AGRIFUR assistant API; while offline
it answers only from the **last verified cache** delivered by
`POST /api/voice-devices/:id/sync` — quoting the real `observed_at` timestamp
("last recorded … at …", never "current …") as the backend instructs in the
sync response.

## Build

```bash
# PlatformIO
pio run -t upload
# Arduino IDE: add ESP32 board core, install PubSubClient + ArduinoJson,
# copy src/secrets.example.h -> src/secrets.h, flash as agrifur2_esp32.ino
```

Real end-to-end verification still requires: ESP32 board, WiFi, an MQTT 5
broker (docker compose `mqtt` service), and the AGRIFUR backend in
`DATABASE_MODE=postgres`.
