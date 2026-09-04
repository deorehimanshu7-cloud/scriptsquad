/**
 * AGRIFUR — ESP32 real-sensor node over plain HTTP (DEVELOPMENT path)
 * ===================================================================
 * Real hardware → Wi-Fi → HTTP POST → AGRIFUR backend → validation →
 * OBSERVED evidence → world model → UI.
 *
 * No MQTT, no PubSubClient, no cloud service. The simplest working path for
 * getting REAL DHT11 + soil-moisture readings into the AGRIFUR backend.
 *
 * Endpoint (see apps/api/src/routes/devHardware.ts):
 *   POST http://{BACKEND_HOST}:{BACKEND_PORT}/api/dev/hardware/telemetry
 *
 * Body:
 * {
 *   "field_id": "fld_...",            // your field id (AGRIFUR web app)
 *   "device_id": "AGRIFUR-ESP32-01",  // auto-registered on first POST
 *   "temperature_c": 27.4,            // real DHT11 value
 *   "humidity_percent": 61.2,         // real DHT11 value
 *   "soil_moisture_raw": 2380,        // real ADC value (0..4095)
 *   "observed_at": "2026-09-04T10:31:00.000Z",  // real NTP time (UTC); omitted until synced
 *   "reading_id": "..."               // idempotency key → backend dedupes retries
 * }
 *
 * HONESTY: if a sensor read fails, that value is OMITTED from the payload.
 * The firmware never fabricates a value and never sends 0 for a failed read.
 * The raw ADC count is sent uncalibrated (0..4095) — the backend stores it
 * as-is rather than inventing a percentage without a calibration curve.
 *
 * Libraries (Arduino IDE → Library Manager):
 *   - DHT sensor library by Adafruit
 *   - Adafruit Unified Sensor
 * (WiFi.h and HTTPClient.h ship with the ESP32 core.)
 *
 * BEFORE FLASHING — edit the CONFIG block below:
 *   1. WIFI_SSID / WIFI_PASSWORD  (your Wi-Fi network)
 *   2. BACKEND_HOST = LAN IPv4 of the machine running the AGRIFUR backend
 *      (find it with `ipconfig`; NEVER localhost/127.0.0.1 on the device)
 *   3. BACKEND_PORT = the port the backend listens on (e.g. 3001)
 *   4. FIELD_ID = the field's id from the AGRIFUR web app
 *   5. DEVICE_KEY = the shared key only if the backend sets DEV_TELEMETRY_TOKEN
 *      (leave "" otherwise; the header is simply not sent)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>

// ============================== CONFIG ====================================
// Wi-Fi
const char* WIFI_SSID       = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";

// AGRIFUR backend (the laptop/PC running the API, on the same Wi-Fi).
const char* BACKEND_HOST    = "192.168.1.44"; // <-- LAN IPv4 of the backend machine
const int   BACKEND_PORT    = 3001;           // <-- backend port (e.g. 3001)

// AGRIFUR identity.
const char* FIELD_ID        = "fld_xxxxxxxxxxxx"; // <-- replace (AGRIFUR web app → field id)
const char* DEVICE_ID       = "AGRIFUR-ESP32-01";
const char* FIRMWARE_VER    = "1.1.0-dev-http";

// Optional shared key — only when the backend sets DEV_TELEMETRY_TOKEN.
const char* DEVICE_KEY      = "";             // <-- leave "" when no key is configured

// Timing (milliseconds)
const unsigned long SEND_INTERVAL_MS = 10000; // send a sample every 10 s
// ===========================================================================

// Pins — match your wiring:
#define DHT_PIN        4      // DHT11 data pin
#define DHT_TYPE       DHT11  // DHT11 (use DHT22 if you have a DHT22)
#define SOIL_ADC_PIN   34     // soil moisture AO (ADC1 channel 6 — safe with Wi-Fi)

DHT dht(DHT_PIN, DHT_TYPE);

unsigned long lastSendMs = 0;
unsigned long msgCounter = 0;

// ---------------------------------------------------------------------------
// Time — real NTP timestamps (UTC). Until the clock syncs, observed_at is
// omitted and the backend honestly uses its own receive time.
// ---------------------------------------------------------------------------
bool clockSynced = false;

void syncTime() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  int tries = 0;
  while (tries < 20 && time(nullptr) < 1000000000) {
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
  snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.000Z",
           tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
           tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
  return String(buf);
}

// ---------------------------------------------------------------------------
// Real sensor reads — failures are OMITTED, never replaced with a fake value.
// ---------------------------------------------------------------------------
struct Readings {
  bool hasTemp;
  float temperature;
  bool hasHumidity;
  float humidity;
  bool hasSoil;
  int soilRaw;
};

Readings readSensors() {
  Readings r = {false, 0, false, 0, false, 0};

  // DHT11 — Adafruit lib returns NaN on failure; only report real reads.
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (!isnan(t)) { r.hasTemp = true; r.temperature = t; }
  if (!isnan(h)) { r.hasHumidity = true; r.humidity = h; }

  // Soil moisture — raw 12-bit ADC (0..4095). No calibration curve exists for
  // this probe + soil, so the RAW count is sent and stored as-is (never a fake
  // percentage). Average 8 samples to reduce ADC noise.
  long acc = 0;
  bool ok = true;
  for (int i = 0; i < 8; i++) {
    int v = analogRead(SOIL_ADC_PIN);
    if (v < 0 || v > 4095) { ok = false; break; }
    acc += v;
    delay(5);
  }
  if (ok) { r.hasSoil = true; r.soilRaw = (int)(acc / 8); }

  return r;
}

// ---------------------------------------------------------------------------
// HTTP — build the payload from real reads only, POST it, print the outcome.
// ---------------------------------------------------------------------------
String backendUrl() {
  return String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/dev/hardware/telemetry";
}

void sendTelemetry() {
  Readings r = readSensors();
  if (!r.hasTemp && !r.hasHumidity && !r.hasSoil) {
    Serial.println("[sensors] all reads failed — sending nothing (no fabrication)");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] not connected — skipping this cycle");
    return;
  }

  msgCounter++;
  String ts = isoNow();
  String readingId = String("ag-") + millis() + "-" + msgCounter;

  // Build JSON by hand — only real values are included.
  String payload = "{";
  payload += "\"field_id\":\"" + String(FIELD_ID) + "\",";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"firmware_version\":\"" + String(FIRMWARE_VER) + "\",";
  payload += "\"reading_id\":\"" + readingId + "\"";
  if (ts.length() > 0) payload += ",\"observed_at\":\"" + ts + "\"";
  if (r.hasTemp)    payload += ",\"temperature_c\":" + String(r.temperature, 1);
  if (r.hasHumidity) payload += ",\"humidity_percent\":" + String(r.humidity, 1);
  if (r.hasSoil)    payload += ",\"soil_moisture_raw\":" + String(r.soilRaw);
  payload += "}";

  Serial.println("---");
  Serial.printf("[http] POST %s\n", backendUrl().c_str());
  Serial.printf("[http] payload: %s\n", payload.c_str());

  HTTPClient http;
  http.begin(backendUrl());
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  if (String(DEVICE_KEY).length() > 0) {
    http.addHeader("X-Device-Key", DEVICE_KEY);
  }

  int code = http.POST(payload);
  if (code > 0) {
    String body = http.getString();
    Serial.printf("[http] HTTP status: %d\n", code);
    Serial.printf("[http] response body: %s\n", body.c_str());
    if (code == 200) {
      Serial.println("[http] ACCEPTED — readings stored as OBSERVED evidence");
    } else {
      Serial.println("[http] REJECTED — check field_id/device_id and backend logs");
    }
  } else {
    Serial.printf("[http] request failed (error %d) — will retry next cycle\n", code);
  }
  http.end();

  // Always print the real sensor values for the serial monitor.
  if (r.hasTemp)    Serial.printf("[sensors] temperature_c      = %.1f °C\n", r.temperature);
  if (r.hasHumidity) Serial.printf("[sensors] humidity_percent   = %.1f %%\n", r.humidity);
  if (r.hasSoil)    Serial.printf("[sensors] soil_moisture_raw  = %d (ADC 0..4095)\n", r.soilRaw);
}

// ---------------------------------------------------------------------------
// Setup / loop
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\nAGRIFUR ESP32 HTTP sensor node starting");
  Serial.printf("  device_id: %s\n", DEVICE_ID);
  Serial.printf("  backend:   %s\n", backendUrl().c_str());

  pinMode(SOIL_ADC_PIN, INPUT);
  analogReadResolution(12);
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[wifi] connecting");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" connected, IP ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(" FAILED — check SSID/password and that the ESP32 is in range");
  }

  // NTP — real timestamps; if this never syncs the firmware simply omits
  // observed_at and the backend uses its own receive time.
  syncTime();
  Serial.println(clockSynced ? "[time] NTP synced" : "[time] NTP not synced yet — observed_at omitted");

  lastSendMs = millis();
}

void loop() {
  // Keep Wi-Fi alive; reconnect without blocking forever.
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(2000);
    return;
  }

  unsigned long now = millis();
  if (now - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = now;
    sendTelemetry();
  }
  delay(50);
}
