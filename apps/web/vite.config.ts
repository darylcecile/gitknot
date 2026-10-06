import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { localOrigin } from "./local-origin.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [localOrigin(), react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/openapi.json": {
          target: env.GITKNOT_DEV_API_URL || "http://127.0.0.1:8787",
          changeOrigin: false,
        },
        "/v1": {
          target: env.GITKNOT_DEV_API_URL || "http://127.0.0.1:8787",
          changeOrigin: false,
        },
      },
    },
    build: { target: "es2023", sourcemap: false },
  };
});
