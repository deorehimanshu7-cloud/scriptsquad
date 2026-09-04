# AGRIFUR — full-stack container.
# Serves the built SPA and the Express/Bun API in ONE persistent process
# (deployment guide Option A), so auth and every /api route share one origin.
#
# Build:  docker build -t agrifur .
# Run:    docker run --rm -p 8787:8787 -v agrifur-data:/app/apps/api/data agrifur
# Compose: docker compose up -d --build   (see docker-compose.yml)

# ---- build stage: install deps + produce apps/web/dist and root dist ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime stage: same base, no rebuild needed ----
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app

ENV NODE_ENV=production
ENV PORT=8787
ENV DATABASE_PATH=/app/apps/api/data/agrifur.db

# The API serves the SPA from apps/web/dist (exists from the build stage) and
# owns everything under /api. Keep the SQLite file on a persistent volume.
VOLUME ["/app/apps/api/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "run", "start"]
