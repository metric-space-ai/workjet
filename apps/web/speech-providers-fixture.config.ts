import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Isolierte Fixture: Sprachausgabe und Modelle › Anbieter, kein Backend, keine Verbindungen. */
const root = NodeURL.fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  cacheDir: NodePath.join(
    process.env.TMPDIR ?? "/Volumes/tmp/dev-artifacts/workjet/speech-providers-fixture",
    "vite-speech-providers-fixture",
  ),
  plugins: [react(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
    alias: [
      // Kein Router in der Fixture: Link/useNavigate sind Attrappen, der Rest ist echt.
      {
        find: /^@tanstack\/react-router$/,
        replacement: NodePath.join(root, "src/fixtures/router-shim.tsx"),
      },
      {
        find: /^fixture-real-router$/,
        replacement: NodePath.join(root, "node_modules/@tanstack/react-router/dist/esm/index.js"),
      },
    ],
  },
  server: { host: "127.0.0.1", port: 5771, strictPort: true },
});
