import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Isolierte Fixture „Projekt anlegen“ mit Quellen und Seitenleistensuche: keine App-Anmeldung, kein Backend, keine echten Verbindungen. */
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: NodePath.join(
    process.env.TMPDIR ?? "/Volumes/tmp/dev-artifacts/workjet/projekt-quellen-fixture",
    "vite-projekt-quellen-fixture",
  ),
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5769, strictPort: true },
});
