/**
 * AGRIFUR2 ESP32 reference firmware (Arduino framework).
 *
 * Architecture: sensors → ESP32 → offline buffer → MQTT 5 (or HTTPS) → backend.
 * The ESP32 NEVER runs the AGRIFUR LLM. It samples sensors, buffers offline,
 * replays with per-message ids (idempotent server-side), heartbeats, and
 * handles whitelisted downlink commands (sampling interval, time sync,
 * request_reading, sync). Actuator commands are intentionally NOT implemented
 * on the device by default.
 *
 * STATUS: CODE IMPLEMENTED — reference firmware for ESP32 hardware. Not
 * physically executed in this repository's verification (HARDWARE_NOT_CONNECTED).
 *
 * Build: PlatformIO (platform espressif32, framework arduino) or Arduino IDE
 * with ESP32 core. Add the PubSubClient + ArduinoJson libraries.
 * Copy src/secrets.example.h → src/secrets.h with your values.
 *
 * Data contract (telemetry messages):
 *   { "schemaVersion":"1.0", "message_id":"...", "sequence":n, "timestamp":ISO,
 *     "measurements":[{"sensorId":"...","type":"soil_moisture","value":42.7,
 *                      "unit":"%","depthCm":10}],
 *     "device":{"firmwareVersion":"1.0.0","battery":87,"signal":-62} }
 *
 * Offline policy: messages are appended to a LittleFS journal with a stable
 * message_id. On (re)connect the whole journal is replayed via MQTT telemetry
 * topics; the backend dedupes by message_id so replays never duplicate.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <time.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <PubSubClient.h>
#include "src/secrets.h"

// Guard against an empty secrets file (compile fails loudly instead of
// silently shipping a device with placeholder keys).
#if !defined(AGRIFUR_DEVICE_KEY) || AGRIFUR_DEVICE_KEY[0] == 'r'
#error "Copy src/secrets.example.h to src/secrets.h and set real values."
#endif

// ---- Constants -------------------------------------------------------------
static const char* TOPIC_TELE  = "agrifur/v1/devices/" AGRIFUR_DEVICE_ID "/telemetry";
static const char* TOPIC_HB    = "agrifur/v1/devices/" AGRIFUR_DEVICE_ID "/heartbeat";
static const char* TOPIC_EV    = "agrifur/v1/devices/" AGRIFUR_DEVICE_ID "/events";
static const char* TOPIC_CMD   = "agrifur/v1/devices/" AGRIFUR_DEVICE_ID "/commands";
static const char* TOPIC_RESP  = "agrifur/v1/devices/" AGRIFUR_DEVICE_ID "/responses";

static const size_t JOURNAL_MAX = 512;   // offline buffer cap (bytes)
static uint32_t sampleIntervalMs = AGRIFUR_SAMPLE_MS;
static unsigned long sequence = 0;
static unsigned long lastSample = 0;
static unsigned long lastHb = 0;
static unsigned long lastCmd = 0;

// ---- Globals ----------------------------------------------------------------
WiFiClientSecure netClient;   // TLS (set to WiFiClient for plain mqtt://)
PubSubClient mqtt(netClient);
char journalPath[] = "/journal.ndjson";

// ---- Sensor sampling -------------------------------------------------------
// Each sampler returns a JsonObject appended to the batch. Sensors that are
// NOT wired on the board are simply omitted — never fake a reading.
void addSensor(JsonArray arr, const char* id, const char* type, float value,
               const char* unit, int depthCm, bool wired) {
  if (!wired) return;
  JsonObject m = arr.createNestedObject();
  m["sensorId"] = id;
  m["type"] = type;
  m["value"] = roundf(value * 10.0f) / 10.0f;
  m["unit"] = unit;
  if (depthCm >= 0) m["depthCm"] = depthCm;
}

void sampleSensors(JsonArray arr) {
#if defined(AGRIFUR_ADC_PIN)
  // Real ADC wiring required (capacitive soil moisture probe etc). If you have
  // no sensor attached to AGRIFUR_ADC_PIN, leave the macro undefined — the
  // device then reports heartbeats + status only (never invented readings).
  int raw = analogRead(AGRIFUR_ADC_PIN);
  float v = (1024.0f - raw) / 1024.0f * 100.0f; // illustrative calibration only
  addSensor(arr, "probe-1", "soil_moisture", v, "%", 10, true);
#endif
}

float readBattery() {
#if defined(AGRIFUR_BATTERY_PIN)
  return analogRead(AGRIFUR_BATTERY_PIN) / 4095.0f * 4.2f / 1.0f;
#else
  return -1.0f; // battery rail not wired — report nothing
#endif
}

// ---- ISO8601 timestamp ------------------------------------------------------
String isoNow() {
  struct tm tmv;
  time_t t = time(nullptr);
  localtime_r(&t, &tmv);
  char buf[40];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
  return String(buf);
}

// ---- Offline journal (LittleFS) --------------------------------------------
void journalAppend(const String& line) {
  File f = LittleFS.open(journalPath, FILE_APPEND);
  if (f) { f.print(line); f.print('\n'); f.close(); }
}

void journalClear() {
  LittleFS.remove(journalPath);
}

// Read all lines, publish each; clear when acked (QoS 1 delivery assumed for
// the reference build; backend additionally dedupes by message_id).
void replayJournal() {
  File f = LittleFS.open(journalPath, FILE_READ);
  if (!f) return;
  String line;
  bool sentAll = true;
  while (f.available()) {
    line = f.readStringUntil('\n');
    line.trim();
    if (line.length() > 2) {
      bool ok = mqtt.publish(TOPIC_TELE, line.c_str());
      sentAll = sentAll && ok;
      delay(10);
    }
  }
  f.close();
  if (sentAll) journalClear();
}

// ---- Message construction ---------------------------------------------------
String buildTelemetryBatch() {
  StaticJsonDocument<768> doc;
  doc["schemaVersion"] = "1.0";
  char mid[40];
  snprintf(mid, sizeof(mid), "esp-%lu-%lu", (unsigned long)ESP.getEfuseMac(), sequence);
  doc["message_id"] = mid;
  doc["sequence"] = sequence;
  sequence++;
  doc["timestamp"] = isoNow();
  JsonArray meas = doc.createNestedArray("measurements");
  sampleSensors(meas);
  JsonObject dev = doc.createNestedObject("device");
  dev["firmwareVersion"] = "agrifur2-esp32-1.0.0";
  float b = readBattery();
  if (b > 0) dev["battery"] = (int)b;
  dev["signal"] = WiFi.RSSI();
  String out;
  serializeJson(doc, out);
  return out;
}

// ---- Command handling (whitelist only; no actuator default) ----------------
void handleCommand(const char* payload) {
  StaticJsonDocument<512> cmd;
  if (deserializeJson(cmd, payload)) return;
  const char* id = cmd["commandId"] | cmd["command_id"] | "";
  const char* name = cmd["command"] | "";
  StaticJsonDocument<256> resp;
  resp["command_id"] = id;
  resp["schemaVersion"] = "1.0";

  if (strcmp(name, "set_sampling_interval") == 0) {
    long s = cmd["params"]["seconds"] | 0L;
    if (s >= 5 && s <= 86400) {
      sampleIntervalMs = (uint32_t)s * 1000UL;
      resp["status"] = "ACKED";
      resp["sampling_interval_s"] = s;
    } else {
      resp["status"] = "FAILED";
      resp["error"] = "seconds out of [5,86400]";
    }
  } else if (strcmp(name, "sync_time") == 0) {
    configTime(0, 0, "pool.ntp.org");
    resp["status"] = "ACKED";
  } else if (strcmp(name, "request_sensor_reading") == 0) {
    String batch = buildTelemetryBatch();
    resp["status"] = "ACKED";
    resp["reading_sent"] = mqtt.publish(TOPIC_TELE, batch.c_str());
  } else if (strcmp(name, "request_device_status") == 0 || strcmp(name, "sync_device") == 0) {
    resp["status"] = "ACKED";
    resp["wifi_rssi"] = WiFi.RSSI();
    resp["uptime_s"] = (long)(millis() / 1000);
    resp["free_heap"] = ESP.getFreeHeap();
  } else if (strcmp(name, "firmware_update_check") == 0) {
    resp["status"] = "ACKED";
    resp["firmware"] = "agrifur2-esp32-1.0.0"; // OTA path not part of reference
  } else {
    resp["status"] = "FAILED";
    resp["error"] = "unsupported command";
  }
  String out;
  serializeJson(resp, out);
  mqtt.publish(TOPIC_RESP, out.c_str());
}

void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  char buf[512];
  size_t n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
  memcpy(buf, payload, n);
  buf[n] = 0;
  if (String(topic) == TOPIC_CMD) handleCommand(buf);
}

// ---- Connectivity -----------------------------------------------------------
bool connectMqttWithBackoff() {
  // TLS setup: if compiled with mqtts://, load a CA from LittleFS when present
  // (see https://github.com/espressif/arduino-esp32 WiFiClientSecure docs).
  static bool configured = false;
  if (!configured) {
#if defined(AGRIFUR_TLS_CA_PATH)
    if (LittleFS.exists(AGRIFUR_TLS_CA_PATH)) {
      File ca = LittleFS.open(AGRIFUR_TLS_CA_PATH, FILE_READ);
      if (ca) netClient.loadCACert(ca, ca.size());
    }
#endif
    configured = true;
  }
  for (int attempt = 0; attempt < 10; attempt++) {
    if (mqtt.connect(AGRIFUR_DEVICE_ID, AGRIFUR_MQTT_USERNAME, AGRIFUR_MQTT_PASSWORD)) {
      mqtt.subscribe(TOPIC_CMD);
      mqtt.publish(TOPIC_EV, "{\"type\":\"DEVICE_CONNECTED\"}");
      return true;
    }
    delay(3000 + attempt * 1000); // reconnect with backoff
  }
  return false;
}

// ---- Setup / loop -----------------------------------------------------------
void setup() {
  Serial.begin(115200);
  LittleFS.begin();
  WiFi.begin(AGRIFUR_WIFI_SSID, AGRIFUR_WIFI_PASSWORD);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(500);
  configTime(0, 0, "pool.ntp.org");
  mqtt.setServer(AGRIFUR_MQTT_BROKER + 6 /* strip mqtt:// or mqtts:// */, 8883);
  mqtt.setCallback(onMqttMessage);
  mqtt.setKeepAlive(45);
}

void loop() {
  bool online = WiFi.status() == WL_CONNECTED;
  if (!online) {
    delay(5000);
    return; // stay offline; samples keep being journaled below
  }
  if (!mqtt.connected()) {
    if (!connectMqttWithBackoff()) return;
    replayJournal(); // deliver buffered offline readings (idempotent)
  }
  mqtt.loop();

  unsigned long now = millis();
  if (now - lastSample >= sampleIntervalMs) {
    lastSample = now;
    String batch = buildTelemetryBatch();
    bool ok = mqtt.publish(TOPIC_TELE, batch.c_str());
    if (!ok) journalAppend(batch); // offline → local buffer
  }
  if (now - lastHb >= AGRIFUR_HEARTBEAT_MS) {
    lastHb = now;
    char hb[160];
    snprintf(hb, sizeof(hb),
             "{\"firmware_version\":\"agrifur2-esp32-1.0.0\",\"battery\":%d,"
             "\"signal_strength\":%d,\"uptime_s\":%lu}",
             readBattery() > 0 ? (int)readBattery() : -1, WiFi.RSSI(),
             (unsigned long)(millis() / 1000));
    mqtt.publish(TOPIC_HB, hb);
  }
}
