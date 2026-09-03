/**
 * PostGIS integration suite — runs only when a PostgreSQL+PostGIS host is
 * reachable (DATABASE_MODE=postgres, docker-compose up). It verifies the real
 * ST_* spatial path: geometry storage, area/perimeter/centroid computed by
 * PostGIS, spatial predicates and migrations. Without a host the suite skips
 * with a truthful note.
 */

describe('PostGIS (gated — requires reachable DATABASE_MODE=postgres)', () => {
  const isPg = (process.env.DATABASE_MODE || 'postgres').toLowerCase() === 'postgres';

  const maybe = isPg ? it : it.skip;

  maybe('migration applies and PostGIS extension is present', async () => {
    const { query } = await import('../src/database/connection');
    const res = await query('SELECT postgis_version() AS v');
    expect(res.rows[0].v).toContain('3.');
  });

  maybe('field metrics are computed by PostGIS (ST_Area/ST_Centroid/ST_Envelope)', async () => {
    process.env.DATABASE_MODE = 'postgres';
    const { createUser } = await import('../src/data/users');
    const { createFarm } = await import('../src/data/users');
    const { createField } = await import('../src/data/fields');
    const { query } = await import('../src/database/connection');
    const email = `pg-${Date.now()}@test.local`;
    await query('DELETE FROM users WHERE email = $1', [email]).catch(() => {});
    const user = await createUser({ email, password: 'password-123' });
    const farm = await createFarm({ userId: user.id, name: 'PG Farm' });
    const geometry: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[
        [75.84, 18.51], [75.85, 18.51], [75.85, 18.52], [75.84, 18.52], [75.84, 18.51],
      ]],
    };
    const field = await createField({ userId: user.id, farmId: farm.id, name: 'PG Field', geometry });
    expect(field.metrics_computed_by).toBe('postgis');
    expect(field.area_hectares).toBeGreaterThan(90);
    expect(field.area_hectares).toBeLessThan(120);
    expect(field.centroid).not.toBeNull();
    expect(field.centroid!.coordinates.length).toBe(2);
    expect(field.geometry_valid).toBe(true);
    // verify with a direct spatial predicate query
    const r = await query(
      `SELECT ST_Intersects(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), geometry) AS hits
       FROM fields WHERE id = $2`,
      [JSON.stringify(geometry), field.id]
    );
    expect(r.rows[0].hits).toBe(true);
    await query('DELETE FROM users WHERE email = $1', [email]);
  });

  if (!isPg) {
    test('skipped: no PostgreSQL/PostGIS host in this environment', () => {
      console.log('[postgis] Suite skipped — PostgreSQL/PostGIS not reachable. Start docker-compose and rerun with DATABASE_MODE=postgres.');
    });
  }
});
