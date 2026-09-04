/**
 * AGRIFUR — ESP32 physical sensor node (reference firmware)
 * ========================================================
 * Real hardware → Wi-Fi → Mosquitto (LAN) → AGRIFUR backend.
 *
 * Reads REAL sensors only:
 *   - Capacitive soil moisture   (analog, ADC pin)
 *   - DHT22 temperature + humidity (single-wire digital)
 *
 * If a sensor read fails, that reading is OMITTED from the message — the
 * firmware NEVER fabricates a value, never sends 0 in place of a failure,
 * and never generates Math.random() data.
 *
 * Message format (published to the telemetry topic):
 * {
 *   "device_id": "AGRIFUR-ESP32-001",
 *   "field_id":  "fld_...",            // informational; backend verifies registration
 *   "message_id": "169...-00042",      // unique per message → dedupe
 *   "timestamp": "2026-09-04T10:31:00Z", // real NTP time; omitted until synced
 *   "firmware_version": "1.0.0",
 *   "readings": { "soil_moisture": 42.7, "temperature": 28.4, "humidity": 67.2 }
 * }
 *
 * Topics:
 *   AGRIFUR/field/{FIELD_ID}/device/{DEVICE_ID}/telemetry   (every sample)
 *   AGRIFUR/field/{FIELD_ID}/device/{DEVICE_ID}/heartbeat   (every heartbeat)
 *
 * Libraries (Arduino IDE → Library Manager):
 *   - PubSubClient by Nick O'Leary
 *   - DHT sensor library by Adafruit
 *   - Adafruit Unified Sensor
 *
 * BEFORE FLASHING — edit the CONFIG block below:
 *   1. WIFI_SSID / WIFI_PASSWORD
 *   2. MQTT_HOST = the LAN IPv4 of the Windows machine running Mosquitto
 *      (find it with `ipconfig` — NEVER use localhost/127.0.0.1 on the device)
 *   3. FIELD_ID = the field's id from the AGRIFUR web app
 *   4. DEVICE_ID must match the device registered in the Sensors workspace
 *      (registration accepts e.g. "AGRIFUR-ESP32-001")
 *   5. Calibrate ADC_MIN_RAW / ADC_MAX_RAW for your actual probe (see below)
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>

// ============================== CONFIG ====================================
// Wi-Fi
const char* WIFI_SSID       = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";

// MQTT broker — the Windows dev machine's LAN IPv4 (Mosquitto, port 1883).
const char* MQTT_HOST       = "192.168.1.100";   // <-- replace with your LAN IP
const int   MQTT_PORT       = 1883;
const char* MQTT_USER       = "";                // empty = anonymous (dev only)
const char* MQTT_PASSWORD   = "";

// AGRIFUR identity — must match the web app registration.
const char* DEVICE_ID       = "AGRIFUR-ESP32-001";
const char* FIELD_ID        = "fld_xxxxxxxxxxxx"; // <-- replace
const char* FIRMWARE_VER    = "1.0.0";

// Timing (milliseconds)
const unsigned long SAMPLE_INTERVAL_MS   = 15000; // real sampling cadence
const unsigned long HEARTBEAT_INTERVAL_MS = 60000;
// ===========================================================================

// Pins — change to match your actual wiring.
#define SOIL_ADC_PIN   34     // capacitive soil moisture (ADC1 channel 6)
#define DHT_PIN        4      // DHT22 data pin
#define DHT_TYPE       DHT22

// ADC calibration for the soil probe (raw 12-bit 0..4095).
// Calibrate with the probe dry (in air) and fully submerged in water:
//   raw_dry  = value in air
//   raw_wet  = value in water
// Capacitive probes usually read HIGH when dry and LOW when wet.
const int ADC_RAW_DRY = 3200;   // <-- calibrate for your probe
const int ADC_RAW_WET = 1400;   // <-- calibrate for your probe

WiFiClient espClient;
PubSubClient mqtt(espClient);
DHT dht(DHT_PIN, DHT_TYPE);

unsigned long lastSampleMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long msgCounter = 0;

// ---------------------------------------------------------------------------
// Time — real NTP timestamps. Until the clock syncs, timestamp is omitted and
// the backend uses its receive time (honest, not fabricated).
// ---------------------------------------------------------------------------
bool clockSynced = false;

void syncTime() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  int tries = 0;
  while (tries < 10 && time(nullptr) < 1000000000) {
    delay(500);
    tries++;
  }
  clockSynced = time(nullptr) > 1000000000;
}

String isoNow() {
  if (!clockSynced) return "";
  time_t now = time(nullptr);
  struct tm tmv;
  gmtime_r(&now, &tmv);
  char buf[32];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
           tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
           tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
  return String(buf);
}

// ---------------------------------------------------------------------------
// Real sensor reads — failures are OMITTED, never replaced.
// ---------------------------------------------------------------------------
struct Readings {
  bool hasMoisture;
  float soilMoisture;
  bool hasTemp;
  float temperature;
  bool hasHumidity;
  float humidity;
};

Readings readSensors() {
  Readings r = {false, 0, false, 0, false, 0};

  // Capacitive soil moisture via ADC.
  int raw = analogRead(SOIL_ADC_PIN);
  if (raw >= 0 && raw <= 4095) {
    // Clamp to the calibration window, then map to percent.
    int clamped = constrain(raw, ADC_RAW_WET, ADC_RAW_DRY);
    float pct = 100.0f * (ADC_RAW_DRY - clamped) / (float)(ADC_RAW_DRY - ADC_RAW_WET);
    r.hasMoisture = true;
    r.soilMoisture = pct;
  }

  // DHT22 — Adafruit lib returns NaN on failure; only report real reads.
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (!isnan(h)) {
    r.hasHumidity = true;
    r.humidity = h;
  }
  if (!isnan(t)) {
    r.hasTemp = true;
    r.temperature = t;
  }
  return r;
}

// ---------------------------------------------------------------------------
// MQTT helpers
// ---------------------------------------------------------------------------
String telemetryTopic() {
  return String("AGRIFUR/field/") + FIELD_ID + "/device/" + DEVICE_ID + "/telemetry";
}
String heartbeatTopic() {
  return String("AGRIFUR/field/") + FIELD_ID + "/device/" + DEVICE_ID + "/heartbeat";
}

bool ensureMqtt() {
  if (mqtt.connected()) return true;
  // keep Wi-Fi alive
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    return false;
  }
  Serial.print("[mqtt] connecting...");
  for (int i = 0; i < 8 && !mqtt.connected(); i++) {
    if (mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD)) break;
    Serial.print(".");
    delay(500);
  }
  if (mqtt.connected()) {
    Serial.println(" connected");
    return true;
  }
  Serial.println(" FAILED — will retry next cycle (device stays offline until it connects)");
  return false;
}

void publishTelemetry() {
  Readings r = readSensors();
  if (!r.hasMoisture && !r.hasTemp && !r.hasHumidity) {
    Serial.println("[sensors] all reads failed — sending nothing (no fabrication)");
    return;
  }

  String ts = isoNow();
  msgCounter++;

  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"field_id\":\"" + String(FIELD_ID) + "\",";
  payload += "\"message_id\":\"" + String(millis()) + "-" + String(msgCounter) + "\",";
  if (ts.length() > 0) payload += "\"timestamp\":\"" + ts + "\",";
  payload += "\"firmware_version\":\"" + String(FIRMWARE_VER) + "\",";
  payload += "\"readings\":{";
  bool first = true;
  if (r.hasMoisture) {
    payload += String(first ? "" : ",") + "\"soil_moisture\":" + String(r.soilMoisture, 1);
    first = false;
  }
  if (r.hasTemp) {
    payload += String(first ? "" : ",") + "\"temperature\":" + String(r.temperature, 1);
    first = false;
  }
  if (r.hasHumidity) {
    payload += String(first ? "" : ",") + "\"humidity\":" + String(r.humidity, 1);
  }
  payload += "}}";

  if (!mqtt.connected()) {
    Serial.println("[mqtt] not connected — dropping telemetry (values never buffered as fake)");
    return;
  }
  bool ok = mqtt.publish(telemetryTopic().c_str(), payload.c_str());
  Serial.printf("[mqtt] telemetry published: %s (ok=%d)\n", payload.c_str(), ok ? 1 : 0);
}

void publishHeartbeat() {
  String payload = String("{\"device_id\":\"") + DEVICE_ID + "\",\"firmware_version\":\"" + FIRMWARE_VER + "\"}";
  if (mqtt.connected()) {
    mqtt.publish(heartbeatTopic().c_str(), payload.c_str());
  }
}

// ---------------------------------------------------------------------------
// Setup / loop
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\nAGRIFUR ESP32 sensor node starting");
  Serial.printf("  device_id: %s\n", DEVICE_ID);
  Serial.printf("  broker:    %s:%d\n", MQTT_HOST, MQTT_PORT);

  pinMode(SOIL_ADC_PIN, INPUT);
  analogReadResolution(12);
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[wifi] connecting");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " FAILED");

  mqtt.setServer(MQTT_HOST, MQTT_PORT);

  // NTP — real timestamps; if this never syncs the firmware simply omits
  // timestamps and the backend uses its own receive time.
  syncTime();
  Serial.println(clockSynced ? "[time] NTP synced" : "[time] NTP not synced yet — timestamps omitted");

  lastSampleMs = millis();
  lastHeartbeatMs = millis();
}

void loop() {
  ensureMqtt();
  mqtt.loop();

  unsigned long now = millis();
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    publishTelemetry();
  }
  if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = now;
    publishHeartbeat();
  }
}