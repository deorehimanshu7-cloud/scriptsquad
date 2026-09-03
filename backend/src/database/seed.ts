/**
 * AGRIFUR2 development seed.
 *
 * Seeds are permitted ONLY in development mode and are explicitly tagged
 * DEVELOPMENT_SEED / DEMO_ONLY. They are never mixed with production
 * evidence. This script refuses to run unless DATABASE_MODE=sqlite-dev AND
 * AGRIFUR2_SEED=development are set.
 *
 * Nothing in the seed enters the evidence store as real evidence; demo fields
 * are created only for UI walkthroughs and are labelled development.
 */
import dotenv from 'dotenv';
dotenv.config();

export async function runSeed(): Promise<void> {
  const mode = process.env.DATABASE_MODE || 'postgres';
  if (mode !== 'sqlite-dev') {
    console.log('[seed] Refusing: development seeds require DATABASE_MODE=sqlite-dev.');
    process.exit(0);
  }
  if (process.env.AGRIFUR2_SEED !== 'development') {
    console.log('[seed] Refusing: set AGRIFUR2_SEED=development to create DEVELOPMENT_SEED demo data.');
    process.exit(0);
  }
  console.log('[seed] DEVELOPMENT_SEED enabled (sqlite-dev only). Creating demo farm/field...');
  const { getDb, hashPassword, generateId } = await import('./sqlite');
  const { computeMetrics } = require('@agrifur2/shared') as typeof import('@agrifur2/shared');
  const db = getDb();
  const email = 'demo@agrifur2.local';
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;
  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    userId = generateId();
    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
      .run(userId, email, hashPassword('demo-password-123'), 'DEMO (development seed)');
    console.log('[seed] Created DEVELOPMENT_SEED user demo@agrifur2.local / demo-password-123');
  }
  const farms = db.prepare('SELECT id FROM farms WHERE user_id = ?').all(userId) as any[];
  let farmId: string;
  if (farms.length > 0) {
    farmId = farms[0].id;
  } else {
    farmId = generateId();
    db.prepare('INSERT INTO farms (id, user_id, name, location) VALUES (?, ?, ?, ?)')
      .run(farmId, userId, 'DEMO FARM (development)', JSON.stringify({ type: 'Point', coordinates: [75.85, 18.52] }));
  }
  const fields = db.prepare('SELECT id FROM fields WHERE user_id = ?').all(userId) as any[];
  if (fields.length === 0) {
    // ~35 ha demo polygon near Solapur, Maharashtra
    const geometry: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[
        [75.8432, 18.5141], [75.8478, 18.5143], [75.8501, 18.5129], [75.8504, 18.5108],
        [75.8489, 18.5089], [75.8451, 18.5087], [75.8429, 18.5103], [75.8428, 18.5124], [75.8432, 18.5141],
      ]],
    };
    const metrics = computeMetrics(geometry);
    const fieldId = generateId();
    db.prepare(`INSERT INTO fields (id, farm_id, user_id, name, geometry, geometry_valid, area_m2, area_hectares,
      perimeter_m, centroid, bbox, srid, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fieldId, farmId, userId, 'DEMO FIELD (development seed)', JSON.stringify(geometry), 1,
        Math.round(metrics.area_m2), Math.round(metrics.area_hectares * 10000) / 10000, Math.round(metrics.perimeter_m),
        JSON.stringify(metrics.centroid), JSON.stringify(metrics.bbox), 4326, 'active');
    console.log(`[seed] Created DEVELOPMENT_SEED field (${metrics.area_hectares.toFixed(2)} ha) — not real evidence.`);
  } else {
    console.log('[seed] Development seed fields already exist — skipping.');
  }
  console.log('[seed] Done. Log in with demo@agrifur2.local / demo-password-123 (development only).');
}

// Only run when executed directly
if (require.main === module) {
  runSeed().catch((e) => { console.error('[seed] Failed:', e.message); process.exit(1); });
}
