import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { openDb } from "./db";
import { config } from "./config";
import { corsMiddleware, errorHandler, notFound, requestContext, audit } from "./http";
import { maybeSeedOnBoot } from "./scripts/seed";
import { authRoutes } from "./routes/auth";
import { farmRoutes } from "./routes/farms";
import { worldRoutes } from "./routes/world";
import { intelRoutes } from "./routes/intel";
import { spaceRoutes } from "./routes/space";
import { hardwareRoutes } from "./routes/hardware";
import { farmerRoutes } from "./routes/farmer";
import { simRoutes } from "./routes/sims";
import { assistantRoutes } from "./routes/assistant";
import { twinRoutes } from "./routes/twin";
import { publicHealthRoute, seedProviderStates, systemRoutes } from "./routes/system";
import { recoverStaleJobs } from "./services/jobs";
import { startWorker } from "./worker";
import { startMqttSubscriber } from "./services/mqtt";

export function createApp(dbLocation = config.databasePath) {
  const db = openDb(dbLocation);
  seedProviderStates(db);
  maybeSeedOnBoot(db);
  recoverStaleJobs(db);

  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(corsMiddleware(process.env.WEB_ORIGIN ?? null));
  app.use(express.json({ limit: "2mb" }));

  // public probes
  app.get("/api/health", publicHealthRoute(db));

  app.use("/api/auth", authRoutes(db));
  app.use("/api", farmRoutes(db));
  app.use("/api", worldRoutes(db));
  app.use("/api", intelRoutes(db));
  app.use("/api", spaceRoutes(db));
  app.use("/api", hardwareRoutes(db));
  app.use("/api", farmerRoutes(db));
  app.use("/api", simRoutes(db));
  app.use("/api", assistantRoutes(db));
  app.use("/api", twinRoutes(db));
  app.use("/api", systemRoutes(db));

  app.use("/api", notFound);
  app.use("/api", errorHandler);

  // Serve the built web app (apps/web/dist) when it exists — single-process
  // preview/production mode. The API keeps owning everything under /api.
  const webDist = config.webDistDir;
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/ , (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
    console.log(`[api] serving web build from ${webDist}`);
  } else {
    console.log(`[api] no web build at ${webDist} (frontend served by Vite in dev)`);
  }

  return { app, db };
}

export function startServer(port = config.port) {
  const { app, db } = createApp();
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`[api] AGRIFUR2 API listening on http://0.0.0.0:${port} (db: ${db.location})`);
  });
  // start the continuous-monitoring worker in the same process (dev convenience)
  const worker = startWorker(db);
  // physical sensor activation: MQTT subscriber (no-op unless MQTT_BROKER_URL set)
  const mqtt = startMqttSubscriber(db);
  return { server, db, worker, mqtt };
}

// Run directly: bun src/index.ts
if (import.meta.main) {
  const { server, db, mqtt } = startServer();
  const shutdown = () => {
    console.log("[api] shutting down");
    try {
      mqtt.stop();
    } catch {
      /* already stopped */
    }
    server.close(() => process.exit(0));
    db.conn.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => console.error("[api] unhandled rejection:", e));
  audit(db, undefined, "system.boot", "api", { version: "0.1.0" });
}

export default createApp;