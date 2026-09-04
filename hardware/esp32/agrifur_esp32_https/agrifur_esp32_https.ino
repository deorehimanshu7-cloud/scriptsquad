/**
 * AGRIFUR — ESP32 real-sensor node over HTTPS (PRODUCTION gateway path)
 * =====================================================================
 * Real hardware → Wi-Fi → HTTPS POST → AGRIFUR hardware gateway →
 * validation → OBSERVED evidence → world model → UI.
 *
 * Same honest sensor handling as the other reference firmware (real DHT11 +
 * raw soil-moisture ADC, failures omitted, nothing fabricated), but over TLS
 * to a public HTTPS host, authenticated with the server-side device key:
 *
 *   POST https://{BACKEND_HOST}/api/hardware/telemetry
 *   header: x-device-key: <HARDWARE_GATEWAY_TOKEN>
 *
 * Body (canonical firmware shape, same as the MQTT subscriber):
 * {
 *   "device_id": "AGRIFUR-ESP32-01",        // external id — MUST be registered
 *                                           // on its field first (Sensors workspace)
 *   "field_id": "fld_...",                  // informational; the backend trusts
 *                                           // the device registration, not this
 *   "message_id": "169...-00042",           // unique per message → dedupe
 *   "timestamp": "2026-09-04T10:31:00.000Z",// real NTP time; omitted until synced
 *   "firmware_version": "1.2.0",
 *   "readings": {
 *     "temperature": 27.4,                  // real DHT11 (°C)
 *     "humidity": 61.2,                     // real DHT11 (%)
 *     "soil_moisture_raw": 2380             // real ADC 0..4095 (uncalibrated)
 *   }
 * }
 *
 * TLS notes:
 *   - The host must terminate HTTPS with a certificate the device can verify.
 *   - Set SERVER_ROOT_CA to the full PEM root/intermediate CA chain of your
 *     host's certificate (most public hosts → Let's Encrypt ISRG Root X1).
 *   - ALLOW_INSECURE_TLS=1 skips verification (self-signed/LAN testing ONLY —
 *     never for the public internet; the key alone would be sent in clear).
 *   - Certificate validation needs a valid clock: the sketch syncs NTP first
 *     and will not POST over TLS until the time is set.
 *
 * Libraries: DHT sensor library by Adafruit, Adafruit Unified Sensor.
 * BEFORE FLASHING — edit the CONFIG block (SSID/password, host, key, field).
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>

// ============================== CONFIG ====================================
const char* WIFI_SSID       = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";

// Public HTTPS host of the AGRIFUR backend (no scheme, no path).
const char* BACKEND_HOST    = "agrifur.example.com";
const int   BACKEND_PORT    = 443;              // standard HTTPS
const char* BACKEND_PATH    = "/api/hardware/telemetry";

// Server-side secret — must match HARDWARE_GATEWAY_TOKEN on the backend.
const char* DEVICE_KEY      = "YOUR_GATEWAY_TOKEN";

// TLS verification: paste the full PEM root CA (e.g. ISRG Root X1 for Let's
// Encrypt hosts). Leave "" ONLY together with ALLOW_INSECURE_TLS=1.
const char* SERVER_ROOT_CA  = "";
const bool  ALLOW_INSECURE_TLS = false;         // never true for public hosts

// AGRIFUR identity. DEVICE_ID must be registered on FIELD_ID in the Sensors
// workspace BEFORE this sketch will be accepted (403 otherwise).
const char* DEVICE_ID       = "AGRIFUR-ESP32-01";
const char* FIELD_ID        = "fld_xxxxxxxxxxxx"; // informational
const char* FIRMWARE_VER    = "1.2.0";

const unsigned long SEND_INTERVAL_MS = 10000;   // sample + send every 10 s
// ===========================================================================

#define DHT_PIN        4      // DHT11 data pin
#define DHT_TYPE       DHT11  // DHT11 (use DHT22 if you have a DHT22)
#define SOIL_ADC_PIN   34     // soil moisture AO (ADC1 channel 6)

DHT dht(DHT_PIN, DHT_TYPE);
WiFiClientSecure secureClient;

unsigned long lastSendMs = 0;
unsigned long msgCounter = 0;
bool clockSynced = false;

// ---------------------------------------------------------------------------
// Time — TLS cert validation and honest timestamps both need a real clock.
// ---------------------------------------------------------------------------
void syncTime() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  int tries = 0;
  while (tries < 30 && time(nullptr) < 1000000000) {
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
// Real sensor reads — failures are OMITTED, never replaced.
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

  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (!isnan(t)) { r.hasTemp = true; r.temperature = t; }
  if (!isnan(h)) { r.hasHumidity = true; r.humidity = h; }

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
// HTTPS — build payload from real reads only, POST with the device key.
// ---------------------------------------------------------------------------
String backendUrl() {
  return String("https://") + BACKEND_HOST + BACKEND_PATH;
}

bool ensureTlsReady() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!clockSynced) {
    syncTime();
    if (!clockSynced) {
      Serial.println("[tls] clock not synced yet — waiting (cert validation needs time)");
      return false;
    }
  }
  if (String(SERVER_ROOT_CA).length() > 0) {
    secureClient.setCACert(SERVER_ROOT_CA);
  } else if (ALLOW_INSECURE_TLS) {
    secureClient.setInsecure();
  } else {
    Serial.println("[tls] no SERVER_ROOT_CA and ALLOW_INSECURE_TLS=false — set one of them");
    return false;
  }
  secureClient.setTimeout(10);
  return true;
}

void sendTelemetry() {
  Readings r = readSensors();
  if (!r.hasTemp && !r.hasHumidity && !r.hasSoil) {
    Serial.println("[sensors] all reads failed — sending nothing (no fabrication)");
    return;
  }

  if (!ensureTlsReady()) return;

  msgCounter++;
  String ts = isoNow();
  String messageId = String("ag-") + millis() + "-" + msgCounter;

  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"field_id\":\"" + String(FIELD_ID) + "\",";
  payload += "\"message_id\":\"" + messageId + "\",";
  if (ts.length() > 0) payload += "\"timestamp\":\"" + ts + "\",";
  payload += "\"firmware_version\":\"" + String(FIRMWARE_VER) + "\",";
  payload += "\"readings\":{";
  bool first = true;
  if (r.hasTemp) {
    payload += String(first ? "" : ",") + "\"temperature\":" + String(r.temperature, 1);
    first = false;
  }
  if (r.hasHumidity) {
    payload += String(first ? "" : ",") + "\"humidity\":" + String(r.humidity, 1);
    first = false;
  }
  if (r.hasSoil) {
    payload += String(first ? "" : ",") + "\"soil_moisture_raw\":" + String(r.soilRaw);
  }
  payload += "}}";

  Serial.println("---");
  Serial.printf("[https] POST %s\n", backendUrl().c_str());
  Serial.printf("[https] payload: %s\n", payload.c_str());

  HTTPClient http;
  if (!http.begin(secureClient, backendUrl())) {
    Serial.println("[https] failed to initialise secure connection");
    return;
  }
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);

  int code = http.POST(payload);
  if (code > 0) {
    String body = http.getString();
    Serial.printf("[https] HTTP status: %d\n", code);
    Serial.printf("[https] response body: %s\n", body.c_str());
    if (code == 200) {
      Serial.println("[https] ACCEPTED — readings stored as OBSERVED evidence");
    } else if (code == 401 || code == 403) {
      Serial.println("[https] REJECTED — check DEVICE_KEY and that DEVICE_ID is registered on FIELD_ID");
    } else {
      Serial.println("[https] REJECTED — see response body / backend logs");
    }
  } else {
    Serial.printf("[https] request failed (error %d) — will retry next cycle\n", code);
  }
  http.end();

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
  Serial.println("\nAGRIFUR ESP32 HTTPS sensor node starting");
  Serial.printf("  device_id: %s\n", DEVICE_ID);
  Serial.printf("  backend:   %s\n", backendUrl().c_str());
  Serial.printf("  tls:       %s\n", String(SERVER_ROOT_CA).length() > 0 ? "CA verified" : (ALLOW_INSECURE_TLS ? "INSECURE (self-signed ONLY)" : "UNCONFIGURED"));

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
    Serial.println(" FAILED — check SSID/password");
  }

  syncTime();
  Serial.println(clockSynced ? "[time] NTP synced" : "[time] NTP not synced yet");

  lastSendMs = millis();
}

void loop() {
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
