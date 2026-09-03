// AGRIFUR2 ESP32 — secrets.example.h
// Copy to secrets.h and fill in REAL values for YOUR device.
//
// SECURITY RULES (enforced by design):
//  * Only the per-device key (issued by POST /api/devices/register) lives here.
//  * NEVER embed backend JWT secrets, database credentials or LLM API keys.
//  * MQTT broker TLS: connect over mqtts://:8883 when available; the CA
//    certificate may be stored in LittleFS (file /ca.pem) instead of the
//    sketch, so firmware updates never re-embed credentials.
#pragma once

#define AGRIFUR_WIFI_SSID     "your-wifi"
#define AGRIFUR_WIFI_PASSWORD "your-wifi-password"

// Device identity — from POST /api/devices/register (shown only once)
#define AGRIFUR_DEVICE_ID     "00000000-0000-0000-0000-000000000000"
#define AGRIFUR_DEVICE_KEY    "replace-with-issued-device-key"

// Broker: mqtt://host:1883 (plain, dev) or mqtts://host:8883 (TLS, production)
#define AGRIFUR_MQTT_BROKER   "mqtts://agrifur2.example.com:8883"
#define AGRIFUR_MQTT_USERNAME ""
#define AGRIFUR_MQTT_PASSWORD ""   // broker credentials if the broker requires them

// Sampling + heartbeat cadence (ms)
#define AGRIFUR_SAMPLE_MS     300000UL   // 5 minutes
#define AGRIFUR_HEARTBEAT_MS  60000UL    // 1 minute
