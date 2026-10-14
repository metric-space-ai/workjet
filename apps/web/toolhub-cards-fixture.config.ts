import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Isolierte Freigabe-Karten-Fixture (Toolhub): keine App-Anmeldung, kein Backend, keine echten Verbindungen. */
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: NodePath.join(
    process.env.TMPDIR ?? "/Volumes/tmp/dev-artifacts/workjet/toolhub-cards-fixture",
    "vite-toolhub-cards-fixture",
  ),
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5771, strictPort: true },
});
