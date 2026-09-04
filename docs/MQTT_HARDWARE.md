# AGRIFUR — Physical Sensor Activation (MQTT + ESP32)

This guide activates **real physical sensor telemetry** into AGRIFUR. It connects an
ESP32 sensor node → Wi-Fi → **Mosquitto MQTT** (Windows dev machine, LAN) → the
AGRIFUR backend → OBSERVED evidence → world model → intelligence → realtime UI.

**Absolute rule:** nothing here fabricates values. If the hardware is not
connected the system reports `WAITING_FOR_TELEMETRY` / `OFFLINE` /
`MQTT_UNAVAILABLE` — it never invents readings.

---

## 1. Architecture

```
REAL SENSOR (capacitive soil moisture, DHT22)
      ↓
ESP32 (reference firmware: hardware/esp32/agrifur_esp32/)
      ↓
Wi-Fi (home/office LAN)
      ↓
Mosquitto MQTT — Windows dev machine, port 1883 (hardware/mosquitto/)
      ↓
AGRIFUR API — MQTT subscriber (apps/api/src/services/mqtt.ts)
      ↓
validation → dedupe → observations → OBSERVED evidence (services/telemetry.ts)
      ↓
world model → anomaly/risk/uncertainty/contradiction engines → SSE → frontend
      ↓
AI context (/api/fields/:id/ai-context) + 3D Digital Twin markers
```

The backend and the broker can run on the same Windows machine (backend on
`localhost`, ESP32 on the machine's LAN IP), or the backend can run elsewhere
as long as it can reach the broker URL.

---

## 2. Broker setup (Windows, one time)

Mosquitto is already installed. Use the provided development config:

```
mosquitto -c <repo>\hardware\mosquitto\agrifur-mosquitto.conf -v
```

That config:

- listens on **0.0.0.0:1883** (LAN + localhost) — required so the ESP32 can connect
- allows **anonymous** access — **DEVELOPMENT ONLY**, trusted LAN only
- logs to stdout so you can watch telemetry arrive

**Windows Firewall** (only if the ESP32 is on a different machine):

```
netsh advfirewall firewall add rule name="AGRIFUR MQTT 1883 (LAN only)" dir=in action=allow protocol=TCP localport=1883 profile=private
```

**Find the broker address for the ESP32** — `ipconfig` on the Windows machine,
look for the IPv4 of the active adapter (e.g. `192.168.1.100`). The firmware
must use this LAN IP — the ESP32 can never use `localhost`/`127.0.0.1`.

> Production hardening (username/password, TLS, topic ACLs) is documented in
> comments inside `hardware/mosquitto/agrifur-mosquitto.conf`.

---

## 3. Backend configuration

Set these environment variables on the API process (the Freebuff preview has no
broker on its LAN, so it honestly reports `NOT_CONFIGURED` until configured —
run the API on your Windows machine for the hardware demo):

| Env var | Meaning | Default |
| --- | --- | --- |
| `MQTT_BROKER_URL` | broker URL, e.g. `mqtt://192.168.1.100:1883` | *(unset → subscriber inactive, `NOT_CONFIGURED`)* |
| `MQTT_ENABLED` | force `1`/`0` | auto: `1` when `MQTT_BROKER_URL` set |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | broker credentials (dev: empty) | — |
| `MQTT_TOPIC_PREFIX` | topic tree root | `AGRIFUR` |
| `MQTT_DEVICE_ONLINE_WINDOW_SEC` | last_seen within → ONLINE | `120` |
| `MQTT_DEVICE_STALE_WINDOW_SEC` | last_seen within → STALE | `900` |

The subscriber auto-reconnects, subscribes to
`AGRIFUR/field/+/device/+/telemetry` + `.../heartbeat`, and records broker
health as a first-class provider (`mqtt-broker`): `AVAILABLE` when connected,
`UNAVAILABLE` when the broker is down, `NOT_CONFIGURED` when unset.

---

## 4. Register the device (one time, in the web app)

1. Open **Sensors** workspace → **Register device**.
2. **Device name**: e.g. `Field Node-01`.
3. **Firmware device id (MQTT)**: **must equal** the firmware's `DEVICE_ID`,
   e.g. `AGRIFUR-ESP32-001`. This id is what the device publishes and how the
   backend resolves device → field (the topic's field id is never trusted).
4. Optional `metadata.location = { "lat": ..., "lon": ... }` — if set, the
   3D Digital Twin places the marker at that deployment point instead of the
   field centroid.

---

## 5. ESP32 firmware

Reference firmware: **`hardware/esp32/agrifur_esp32/agrifur_esp32.ino`**

Edit the CONFIG block:

- `WIFI_SSID` / `WIFI_PASSWORD`
- `MQTT_HOST` = **LAN IPv4 of the Windows machine** (never localhost)
- `FIELD_ID` = field id from the web app (field switcher / URL)
- `DEVICE_ID` = the id you registered (e.g. `AGRIFUR-ESP32-001`)
- `ADC_RAW_DRY` / `ADC_RAW_WET` = your probe's dry/wet raw ADC values

Libraries: **PubSubClient**, **Adafruit DHT sensor library**, **Adafruit
Unified Sensor**. Wire: soil probe → `GPIO34`, DHT22 → `GPIO4`.

Behavior:

- every `SAMPLE_INTERVAL_MS` (default 15 s) reads the real sensors and publishes
  a telemetry message; **a failed read is omitted, never replaced**
- every `HEARTBEAT_INTERVAL_MS` (60 s) publishes a heartbeat
- NTP-synced ISO timestamps; until the clock syncs, timestamps are omitted and
  the backend uses its receive time (honest)
- Wi-Fi and MQTT reconnect in `loop()`; while disconnected it drops messages
  rather than buffering fake data

### Telemetry schema

```json
{
  "device_id": "AGRIFUR-ESP32-001",
  "field_id": "fld_xxx",              // informational — registration is authoritative
  "message_id": "13994-00042",        // unique per message → duplicate detection
  "timestamp": "2026-09-04T10:31:00Z", // real NTP time; optional
  "firmware_version": "1.0.0",
  "readings": { "soil_moisture": 42.7, "temperature": 28.4, "humidity": 67.2 }
}
```

`readings` may also be an array `[{sensor_type, value, unit?}]` (the HTTPS
gateway format). The object form uses canonical AGRIFUR sensor names with known
physical ranges (see `SENSOR_RANGES` in `apps/api/src/services/telemetry.ts`).

### Topics

```
AGRIFUR/field/{fieldId}/device/{deviceId}/telemetry   ← every sample
AGRIFUR/field/{fieldId}/device/{deviceId}/heartbeat   ← liveness
```

---

## 6. Validation pipeline (what happens to each message)

| Verdict | Meaning | Stored? |
| --- | --- | --- |
| `VALIDATED` | device known, topic field == registered field, timestamp OK, values within physical bounds | yes, quality high |
| `SUSPECT` | values physically possible but outside the calibration window (e.g. 58 °C) | yes, quality medium, flagged in evidence |
| `REJECTED` | unknown device, wrong field, future/stale timestamp, non-finite or physically impossible value, malformed JSON | **no** |
| `DUPLICATE` | same `message_id` already ingested | **no** (dedupe key) |

Every accepted reading is stored in `observations` (full history, with
`observed_at` and `received_at` preserved) and promoted to **OBSERVED** sensor
evidence with provenance (`transport: mqtt`, message id, validation reason).
`SENSOR_TELEMETRY` / `DEVICE_HEARTBEAT` events are pushed over SSE, so the
frontend updates without a refresh.

Device health is computed from real `last_seen_at`: **ONLINE** (≤ 2 min),
**STALE** (≤ 15 min), **OFFLINE** (older) — a device is never shown ONLINE
forever after disconnecting.

---

## 7. End-to-end check

1. Start Mosquitto (`mosquitto -c ... -v`).
2. Start the API with `MQTT_BROKER_URL=mqtt://<lan-ip>:1883`.
3. Register `AGRIFUR-ESP32-001` on the field in the Sensors workspace.
4. Flash + power the ESP32. Watch Mosquitto's log for the CONNECT and the
   `AGRIFUR/.../telemetry` publishes.
5. In the web app: Sensors workspace shows the device **ONLINE**, the chart
   fills with real readings, World model sensor layer flips to PARTIAL/OBSERVED,
   the Digital Twin shows the device marker, and the assistant/AI context
   includes the live values.
6. **Physical-change test:** wet/dry the probe and confirm the new value flows
   sensor → MQTT → backend → DB → evidence → UI within one sampling interval.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| ESP32 never connects to Wi-Fi | wrong SSID/password; AP on 5 GHz (ESP32 classic is 2.4 GHz only) |
| `[mqtt] connecting... FAILED` | wrong `MQTT_HOST` (must be the Windows LAN IPv4, not localhost); Mosquitto not running or not on `0.0.0.0`; Windows Firewall blocking 1883 on the Private profile |
| Backend shows `MQTT_UNAVAILABLE` | broker unreachable from the API process; check `MQTT_BROKER_URL`, confirm `mosquitto -v` is listening |
| `REJECTED ... not registered` | firmware `DEVICE_ID` ≠ registered `device_id` in the Sensors workspace |
| `REJECTED ... does not match device registration` | topic `fieldId` differs from the field the device is registered on — re-register or fix the topic |
| `REJECTED ... future` / `90 days` | device clock wrong — NTP should fix; until synced, omit the timestamp |
| Readings missing in UI but published | check for `REJECTED`/`SUSPECT` lines in the API log; check cloud cover… no — check the device is on the **active field** |
| Device stays OFFLINE after power-off | correct — health comes from real `last_seen_at`; it goes STALE then OFFLINE by design |

## 9. Honest states

| State | When |
| --- | --- |
| `WAITING_FOR_TELEMETRY` | device registered, no observation received yet |
| `MQTT_UNAVAILABLE` / `UNAVAILABLE` | broker configured but unreachable |
| `MQTT NOT_CONFIGURED` / `NOT_CONFIGURED` | `MQTT_BROKER_URL` not set |
| `OFFLINE` / `STALE` | last real heartbeat/telemetry older than the windows |
| `HARDWARE_NOT_CONNECTED` | no physical device present (this cloud environment) |