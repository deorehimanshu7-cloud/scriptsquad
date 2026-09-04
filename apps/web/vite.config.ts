import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is served by apps/api (default http://localhost:8787). In production
// the built static bundle talks to the API origin configured at runtime via
// window.__AGRIFUR_API__ or the same-origin /api proxy.
const apiTarget = process.env.AGRIFUR_API_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
