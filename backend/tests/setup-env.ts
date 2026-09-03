/**
 * Test environment bootstrap.
 * Defaults to DATABASE_MODE=sqlite-dev with an in-memory/temp SQLite DB.
 * Set DATABASE_MODE=postgres (+ DB_* env) to run the PostGIS-gated suite.
 */
process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_MODE) {
  process.env.DATABASE_MODE = 'sqlite-dev';
}
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';
if (!process.env.JWT_REFRESH_SECRET) process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
