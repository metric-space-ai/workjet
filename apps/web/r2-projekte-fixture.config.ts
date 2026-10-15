import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Isolierte Fixture für die R2-Review-Fixes (Projekte, Instanz-Ruhezustände): kein Backend, keine Verbindungen. */
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: NodePath.join(
    process.env.TMPDIR ?? "/Volumes/tmp/dev-artifacts/workjet/r2-projekte-fixture",
    "vite-r2-projekte-fixture",
  ),
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5793, strictPort: true },
});
