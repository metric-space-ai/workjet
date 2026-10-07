import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Fixture-only dev server; does not load app auth, backend proxies or user env files. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: path.join(process.env.TMPDIR ?? "/Volumes/tmp/dev-artifacts/workjet/jour-fixe-fixture", "vite-fixture"),
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5745, strictPort: true },
});
