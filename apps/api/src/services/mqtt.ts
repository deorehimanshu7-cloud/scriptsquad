/**
 * MQTT subscriber — bridges the LAN Mosquitto broker into the existing AGRIFUR
 * ingestion pipeline. Runs inside the API process (same SQLite DB + event bus
 * as the HTTPS gateway), subscribes to the wildcard telemetry + heartbeat
 * topics, and hands every message to the shared telemetry service for
 * validation, dedupe, OBSERVED evidence and realtime events.
 *
 * Honest states:
 *   - not configured (no broker URL, MQTT_ENABLED unset) → NOT_CONFIGURED
 *   - configured but broker unreachable / reconnecting → UNAVAILABLE
 *   - connected and subscribed → AVAILABLE
 * Health is only re-recorded on state transitions, so a down broker does not
 * spam the provider table or the event stream.
 */
import mqtt, { type MqttClient } from "mqtt";
import type { AppDb } from "../db";
import { config } from "../config";
import { recordHealth } from "../providers/orchestrator";
import { publishEvent } from "./events";
import { handleMqttHeartbeat, handleMqttMessage, type TelemetryResult } from "./telemetry";

export interface MqttOptions {
  brokerUrl: string;
  username?: string;
  password?: string;
  topicPrefix: string;
  reconnectPeriodMs: number;
  connectTimeoutMs: number;
  clientId: string;
  /** force-enable for tests; defaults to config.mqtt.enabled */
  enabled?: boolean;
}

export interface MqttHandle {
  stop: () => void;
  state: () => "disabled" | "connecting" | "connected" | "reconnecting";
  lastError: () => string | null;
}

export function mqttOptionsFromConfig(): MqttOptions {
  return {
    brokerUrl: config.mqtt.brokerUrl,
    username: config.mqtt.username,
    password: config.mqtt.password,
    topicPrefix: config.mqtt.topicPrefix,
    reconnectPeriodMs: config.mqtt.reconnectPeriodMs,
    connectTimeoutMs: config.mqtt.connectTimeoutMs,
    clientId: `agrifur-backend-${process.pid}`,
  };
}

export function startMqttSubscriber(db: AppDb, opts?: Partial<MqttOptions>): MqttHandle {
  const o: MqttOptions = { ...mqttOptionsFromConfig(), ...opts };
  let phase: "disabled" | "connecting" | "connected" | "reconnecting" = "connecting";
  let lastError: string | null = null;
  let lastHealth: string | null = null;

  const record = (status: "AVAILABLE" | "UNAVAILABLE" | "NOT_CONFIGURED", error: string | null, note?: string) => {
    if (lastHealth === status && lastError === error) return;
    lastHealth = status;
    lastError = error;
    recordHealth(db, "mqtt-broker", status, status === "AVAILABLE" ? 0 : null, error);
    publishEvent(db, {
      type: "PROVIDER_STATUS_CHANGED",
      user_id: null,
      farm_id: null,
      field_id: null,
      payload: { provider: "mqtt-broker", status, error, note: note ?? `MQTT broker ${status === "AVAILABLE" ? `connected (${o.brokerUrl})` : status === "NOT_CONFIGURED" ? "not configured" : `unavailable (${o.brokerUrl})`}` },
    });
  };

  if (!(o.enabled ?? config.mqtt.enabled)) {
    record("NOT_CONFIGURED", "MQTT_BROKER_URL not set (or MQTT_ENABLED=0) — telemetry subscriber inactive");
    return {
      stop: () => undefined,
      state: () => "disabled",
      lastError: () => null,
    };
  }

  let client: MqttClient | null = null;
  let stopped = false;
  // AGRIFUR/field/{fieldId}/device/{deviceId}/{telemetry|heartbeat}
  const telemetryTopic = `${o.topicPrefix}/field/+/device/+/telemetry`;
  const heartbeatTopic = `${o.topicPrefix}/field/+/device/+/heartbeat`;

  const subscribeAll = () => {
    client?.subscribe([telemetryTopic, heartbeatTopic], { qos: 0 }, (err) => {
      if (err) {
        lastError = `subscribe failed: ${err.message}`;
        console.error(`[mqtt] ${lastError}`);
      }
    });
  };

  const log = (r: TelemetryResult) => {
    if (r.verdict === "REJECTED") console.warn(`[mqtt] REJECTED ${r.deviceId ?? "?"} ${r.fieldId ?? "?"}: ${r.reason}`);
    else if (r.verdict === "SUSPECT") console.warn(`[mqtt] SUSPECT ${r.deviceId}: ${r.reason}`);
    else if (r.verdict === "DUPLICATE") console.info(`[mqtt] DUPLICATE ${r.deviceId}: ${r.reason}`);
  };

  try {
    client = mqtt.connect(o.brokerUrl, {
      clientId: o.clientId,
      username: o.username,
      password: o.password,
      reconnectPeriod: o.reconnectPeriodMs,
      connectTimeout: o.connectTimeoutMs,
      clean: true,
    });
  } catch (e) {
    record("UNAVAILABLE", e instanceof Error ? e.message : String(e));
    return {
      stop: () => undefined,
      state: () => "reconnecting",
      lastError: () => lastError,
    };
  }

  client.on("connect", () => {
    phase = "connected";
    lastError = null;
    record("AVAILABLE", null);
    subscribeAll();
    console.log(`[mqtt] connected to ${o.brokerUrl} — subscribed ${telemetryTopic} + ${heartbeatTopic}`);
  });
  client.on("reconnect", () => {
    phase = "reconnecting";
    record("UNAVAILABLE", "MQTT broker unreachable — reconnecting");
  });
  client.on("close", () => {
    if (stopped) return;
    phase = "reconnecting";
    record("UNAVAILABLE", "MQTT connection closed");
  });
  client.on("offline", () => {
    phase = "reconnecting";
    record("UNAVAILABLE", "MQTT broker offline");
  });
  client.on("error", (err) => {
    lastError = err.message;
    if (!client?.connected) {
      phase = "reconnecting";
      record("UNAVAILABLE", `MQTT error: ${err.message}`);
    } else {
      console.error(`[mqtt] error: ${err.message}`);
    }
  });
  client.on("message", (topic, payload) => {
    try {
      if (topic.endsWith("/telemetry")) {
        const r = handleMqttMessage(db, topic, payload, o.topicPrefix);
        log(r);
      } else if (topic.endsWith("/heartbeat")) {
        const r = handleMqttHeartbeat(db, topic, payload, o.topicPrefix);
        log(r);
      } else {
        console.warn(`[mqtt] ignored topic ${topic}`);
      }
    } catch (e) {
      console.error(`[mqtt] message handling failed for ${topic}:`, e);
    }
  });

  return {
    stop: () => {
      stopped = true;
      try {
        client?.end(true);
      } catch {
        /* already closed */
      }
      client = null;
    },
    state: () => phase,
    lastError: () => lastError,
  };
}

/** Used by the provider health snapshot to reflect the live broker state. */
export function mqttBrokerHealth(db: AppDb): void {
  if (!config.mqtt.enabled) {
    recordHealth(db, "mqtt-broker", "NOT_CONFIGURED", null, "MQTT_BROKER_URL not set (or MQTT_ENABLED=0) — telemetry subscriber inactive");
  }
  // When enabled, the subscriber itself keeps health current via transitions;
  // a snapshot just re-affirms the last state.
  const row = db.conn.query("SELECT status FROM provider_health WHERE provider='mqtt-broker'").get() as { status: string } | undefined;
  if (row && row.status !== "NOT_CONFIGURED") {
    recordHealth(db, "mqtt-broker", row.status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE", null, row.status === "AVAILABLE" ? null : "MQTT broker unreachable");
  }
}