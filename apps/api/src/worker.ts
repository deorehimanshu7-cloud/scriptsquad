import { openDb, type AppDb } from "./db";
import { config } from "./config";
import { providerHealthSnapshot } from "./providers/orchestrator";
import { listActiveFields } from "./services/worldModel";
import { refreshWeather, refreshSatellite, refreshSoil, refreshTerrain, refreshWater, updateWorldModelAndIntelligence } from "./services/pipeline";
import { recoverStaleJobs, createJob, finishJob } from "./services/jobs";
import { resolveOpenContradictionEvidence } from "./services/investigations";
import { runIntelligence } from "./services/engines";

export interface WorkerHandle {
  stop: () => void;
  tickCount: number;
}

/**
 * Continuous monitoring worker. Runs on a fixed tick; each job type respects
 * its own cadence (seconds). Provider failures never crash the loop — the
 * orchestrator records truthful health states and the field pipeline continues.
 */
export function startWorker(db: AppDb): WorkerHandle {
  recoverStaleJobs(db);
  const lastRun: Record<string, number> = {};
  let tickCount = 0;
  let stopped = false;

  const due = (key: string, intervalSeconds: number): boolean => {
    const last = lastRun[key] ?? 0;
    if (Date.now() - last >= intervalSeconds * 1000) {
      lastRun[key] = Date.now();
      return true;
    }
    return false;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    tickCount++;
    try {
      if (due("provider_health", config.jobProviderHealthSeconds)) {
        await providerHealthSnapshot(db);
      }
    } catch (e) {
      console.error("[worker] provider health tick failed:", e);
    }

    const fields = listActiveFields(db);
    for (const field of fields) {
      // refresh cadence per field
      if (due(`weather:${field.id}`, config.jobWeatherSeconds)) {
        try {
          await refreshWeather(db, field.id);
        } catch (e) {
          console.error(`[worker] weather refresh failed for ${field.id}:`, e);
        }
      }
      if (due(`satellite:${field.id}`, config.jobSatelliteSeconds)) {
        try {
          await refreshSatellite(db, field.id);
        } catch (e) {
          console.error(`[worker] satellite refresh failed for ${field.id}:`, e);
        }
      }
      if (due(`soil:${field.id}`, config.jobSoilSeconds)) {
        try {
          await refreshSoil(db, field.id);
        } catch (e) {
          console.error(`[worker] soil refresh failed for ${field.id}:`, e);
        }
      }
      if (due(`terrain:${field.id}`, 24 * 3600)) {
        try {
          await refreshTerrain(db, field.id);
        } catch (e) {
          console.error(`[worker] terrain refresh failed for ${field.id}:`, e);
        }
      }
      if (due(`water:${field.id}`, 12 * 3600)) {
        try {
          await refreshWater(db, field.id);
        } catch (e) {
          console.error(`[worker] water refresh failed for ${field.id}:`, e);
        }
      }
      if (due(`worldmodel:${field.id}`, config.jobWorldModelSeconds)) {
        try {
          await updateWorldModelAndIntelligence(db, field.id, "SCHEDULED");
        } catch (e) {
          console.error(`[worker] world model update failed for ${field.id}:`, e);
        }
      }
      if (due(`intel:${field.id}`, config.jobIntelligenceSeconds)) {
        try {
          resolveOpenContradictionEvidence(db, field.id);
          runIntelligence(db, field.id);
        } catch (e) {
          console.error(`[worker] intelligence update failed for ${field.id}:`, e);
        }
      }
    }

    // keep a heartbeat job record so the UI can show the scheduler alive
    if (tickCount % 4 === 0) {
      const job = createJob(db, { type: "FIELD_REFRESH", detail: { heartbeat: true, tick: tickCount } });
      finishJob(db, job.id, "SUCCEEDED", { detail: { heartbeat: true, tick: tickCount } });
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, config.workerTickMs);
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tickCount,
  };
}

/** Standalone worker process entry: bun src/worker-only.ts */
export function runWorkerOnly(dbLocation: string): WorkerHandle {
  const db = openDb(dbLocation);
  recoverStaleJobs(db);
  console.log(`[worker] AGRIFUR2 continuous monitoring worker started (db: ${db.location}, tick ${config.workerTickMs}ms)`);
  return startWorker(db);
}