import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Isolierte Composer-Fixture: kein Server, keine Anmeldung, keine Live-Daten. */
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: NodePath.join(
    process.env.TMPDIR ?? "/Volumes/tmp/dev-artifacts/workjet/r1-composer-fixture",
    "vite-r1-composer-fixture",
  ),
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5783, strictPort: true },
});
