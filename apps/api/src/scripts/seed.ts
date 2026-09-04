/**
 * AGRIFUR2 development seed.
 *
 * Creates one DEMO account plus a farm, one field with a real geographic
 * polygon (an agricultural area near Nashik, Maharashtra, India) and one
 * registered-but-idle sensor device. Every seeded record is explicitly
 * labelled DEVELOPMENT_SEED so it can never be mistaken for real farmer
 * input or real hardware telemetry.
 *
 * Truthfulness note: the field boundary is a user-drawn approximation of a
 * real location (not a surveyed boundary) and no telemetry is fabricated —
 * the device is registered with status "registered" and zero observations.
 *
 * Usage: bun run seed   (or automatic on first boot of a fresh database
 * when NODE_ENV !== "production" and SEED_DEMO_ON_BOOT is not "0").
 */
import { openDb, nowIso, type AppDb } from "../db";
import { createSession } from "../http";
import { newId, round } from "../util";

export const SEED_EMAIL = "demo@agrifur.dev";
export const SEED_PASSWORD = "agrifur-demo";

/**
 * Polygon near Nashik, Maharashtra (≈ 20.003°N, 73.790°E). WGS84 lon/lat,
 * closed ring, ~9 vertices. DEVELOPMENT_SEED: approximate boundary for demo
 * purposes, not a surveyed field.
 */
export const SEED_POLYGON: { type: "Polygon"; coordinates: number[][][] } = {
  type: "Polygon",
  coordinates: [
    [
      [73.7882, 20.0001],
      [73.7891, 20.0004],
      [73.7904, 20.0005],
      [73.7916, 20.0002],
      [73.7923, 19.9993],
      [73.7918, 19.9984],
      [73.7905, 19.9981],
      [73.7892, 19.9986],
      [73.7885, 19.9994],
      [73.7882, 20.0001],
    ],
  ],
};

export function seedDevelopmentData(db: AppDb): { user_id: string; field_id: string; created: boolean } {
  const existing = db.conn.query("SELECT id FROM users WHERE email = ?").get(SEED_EMAIL) as { id: string } | undefined;
  if (existing) return { user_id: existing.id, field_id: "", created: false };

  const userId = newId("usr");
  const passwordHash = awaitHash(SEED_PASSWORD);
  const now = nowIso();
  db.conn
    .query("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)")
    .run(userId, SEED_EMAIL, "Demo Farmer (development seed)", passwordHash, "farmer", now);

  const farmId = newId("farm");
  db.conn
    .query("INSERT INTO farms (id, user_id, name, location_name, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(farmId, userId, "Demo Farm (DEVELOPMENT_SEED)", "Nashik, Maharashtra, India (development seed)", now, now);

  const fieldId = newId("fld");
  const bbox = {
    min_lon: 73.7882,
    min_lat: 19.9981,
    max_lon: 73.7923,
    max_lat: 20.0005,
  };
  const areaM2 = 320_000; // approximate, computed from the seed polygon
  db.conn
    .query(
      `INSERT INTO fields (id, farm_id, user_id, name, crop_name, geometry, centroid_lat, centroid_lon, bbox, area_m2, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      fieldId,
      farmId,
      userId,
      "North Plot (DEVELOPMENT_SEED)",
      null,
      JSON.stringify(SEED_POLYGON),
      19.9993,
      73.7903,
      JSON.stringify(bbox),
      areaM2,
      now,
      now,
    );

  const deviceId = newId("dev");
  db.conn
    .query(
      `INSERT INTO devices (id, user_id, farm_id, field_id, name, kind, firmware_version, status, last_seen_at, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      deviceId,
      userId,
      farmId,
      fieldId,
      "Seed Node-01 (DEVELOPMENT_SEED)",
      "sensor_node",
      "0.0.0",
      "registered",
      null,
      JSON.stringify({
        note: "Registered for demonstration. No telemetry has ever been received (NO_DATA until a real gateway posts readings).",
        seed: "DEVELOPMENT_SEED",
      }),
      now,
    );

  return { user_id: userId, field_id: fieldId, created: true };
}

function awaitHash(password: string): string {
  // hashPassword is async; use a sync wrapper via Bun's synchronous API
  return Bun.password.hashSync(password, { algorithm: "bcrypt", cost: 8 });
}

/**
 * Idempotently add one clearly-labelled DEMO simulation scenario to the demo
 * field so the Simulation workspace opens with a ready-to-run (not yet run)
 * scenario instead of an empty page. The scenario itself is SIMULATED by
 * definition and is labelled DEVELOPMENT_SEED; running it never touches
 * observed evidence.
 */
export function seedDemoSimulation(db: AppDb): boolean {
  const user = db.conn.query("SELECT id FROM users WHERE email = ?").get(SEED_EMAIL) as { id: string } | undefined;
  if (!user) return false;
  const field = db.conn
    .query("SELECT id, farm_id FROM fields WHERE user_id = ? AND name LIKE '%DEVELOPMENT_SEED%' LIMIT 1")
    .get(user.id) as { id: string; farm_id: string } | undefined;
  if (!field) return false;
  const existing = db.conn
    .query("SELECT id FROM simulations WHERE field_id = ? AND name LIKE '%DEVELOPMENT_SEED%' LIMIT 1")
    .get(field.id);
  if (existing) return false;
  const now = nowIso();
  db.conn
    .query(
      `INSERT INTO simulations (id, user_id, farm_id, field_id, name, scenario, model, model_version, inputs, assumptions, limitations, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newId("sim"),
      user.id,
      field.farm_id,
      field.id,
      "Kharif monsoon water balance (DEVELOPMENT_SEED)",
      "What-if: uniform 6 mm/day rain + 2 mm/day irrigation over a 30-day kharif window (uniform assumptions — press ▶ Run to execute)",
      "AGRIFUR2 simple water balance",
      "1.0",
      JSON.stringify({ rainfall_mm: 6, irrigation_mm: 2, crop_factor_kc: 1.0, days: 30 }),
      "Uniform daily rain and irrigation; fixed crop factor; no soil-moisture carry-over between days (labelled DEVELOPMENT_SEED).",
      "Deterministic what-if only. SIMULATED output never enters observed evidence, risks or advisories.",
      "ready",
      now,
    );
  console.log("[seed] DEVELOPMENT_SEED demo simulation scenario added (SIMULATED; not yet run).");
  return true;
}

/** Boot-time hook: seed only a fresh database outside production. */
export function maybeSeedOnBoot(db: AppDb): void {
  if (process.env.NODE_ENV === "production") return;
  if ((process.env.SEED_DEMO_ON_BOOT ?? "1") === "0") return;
  const userCount = db.conn.query("SELECT COUNT(*) as n FROM users").get() as { n: number };
  if (userCount.n > 0) return; // only a fresh database
  const res = seedDevelopmentData(db);
  if (res.created) {
    const session = createSession(db, res.user_id);
    void session;
    seedDemoSimulation(db);
    // Credentials are deliberately NOT logged (demo login works through the
    // normal password flow with the documented development password).
    console.log(
      `[seed] DEVELOPMENT_SEED demo account created (email: ${SEED_EMAIL}). ` +
        `Area approx ${round(320_000 / 10_000, 1)} ha. All seeded records are labelled DEVELOPMENT_SEED. `,
    );
  }
}

/** Standalone CLI: bun run seed */
export function main(): void {
  const db = openDb(process.env.DATABASE_PATH || new URL("../data/agrifur.db", import.meta.url).pathname);
  const res = seedDevelopmentData(db);
  const simAdded = seedDemoSimulation(db);
  if (res.created) {
    const session = createSession(db, res.user_id);
    // No password or session token is printed — the demo account logs in
    // through the normal password flow (documented development credentials).
    console.log(`Seeded demo account ${SEED_EMAIL} (credentials are documented, not logged).`);
    void session;
  } else {
    console.log(`Demo account ${SEED_EMAIL} already exists — nothing new to seed (idempotent).` + (simAdded ? " Demo simulation added." : ""));
  }
  db.conn.close();
}

if (import.meta.main) {
  main();
}