import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/lightweight-charts/")) return "vendor-lightweight-charts";
          if (id.includes("/@radix-ui/")) return "vendor-radix-ui";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(directory, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/health": "http://127.0.0.1:3100",
    },
  },
});
