/**
 * Stage the built web bundle for static hosting.
 *
 * The Vite build writes to apps/web/dist (canonical location used by the
 * API/preview). Freebuff static hosting copies its static output from a
 * repo-root dist/ directory, so this script mirrors apps/web/dist into dist/
 * at the end of every root `bun run build`.
 *
 * Paths are resolved from this file's own location, so it works regardless
 * of the invoking working directory or shell.
 */
import { cpSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
const root = path.resolve(here, "..");
const src = path.join(root, "apps", "web", "dist");
const dst = path.join(root, "dist");

if (!existsSync(src)) {
  console.error(`[stage-dist] source web build missing: ${src}`);
  process.exit(1);
}

rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log(`[stage-dist] staged ${src} -> ${dst}`);
