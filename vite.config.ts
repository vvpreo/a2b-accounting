import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev setup: Vite serves the frontend on :3700 and proxies /api to the Rust
// backend (`cargo run` in server/, listening on :3701). In production the
// backend serves the built dist/ itself — see server/src/http.rs.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 3700,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3701",
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ["**/server/**"],
    },
  },
});
