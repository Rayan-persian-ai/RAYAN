import { defineConfig } from "vite";

// In dev, /api is proxied to `wrangler dev` (apps/api) so cookies stay same-origin, like production.
export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  build: { target: "es2022", sourcemap: true },
});
