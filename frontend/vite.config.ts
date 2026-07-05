import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.VITE_PROXY_TARGET || "http://127.0.0.1:8400";
const basePath = process.env.VITE_BASE_PATH || "/pricescan/";

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: {
    port: 8300,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/pricescan/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pricescan\/api/, ""),
      },
    },
  },
});
