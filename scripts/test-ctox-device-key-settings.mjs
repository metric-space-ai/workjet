// Bounded isolated browser fixture: production settings components, public metadata only.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const requireWeb = NodeModule.createRequire(NodePath.join(repo, "apps/web/package.json"));
const requireDesktop = NodeModule.createRequire(NodePath.join(repo, "apps/desktop/package.json"));
const { createServer } = await import(requireWeb.resolve("vite"));
const { default: tailwindcss } = await import(requireWeb.resolve("@tailwindcss/vite"));
const { default: react } = await import(requireWeb.resolve("@vitejs/plugin-react"));
const { default: playwright } = await import(requireDesktop.resolve("playwright-core"));
const { chromium } = playwright;
const output = process.env.DEVICE_UI_EVIDENCE_DIR;
NodeAssert.ok(output, "Set DEVICE_UI_EVIDENCE_DIR to a disposable evidence directory");
await NodeFSP.mkdir(output, { recursive: true });
let status = {
  state: "active",
  createdAt: "2026-10-11T17:00:00Z",
  lastUsedAt: "2026-10-11T17:05:00Z",
  expiresAt: "2026-11-10T17:05:00Z",
};
let resets = 0;
const fixtureModule = NodePath.join(repo, "apps/web/__device-key-fixture.tsx");
const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { CtoxDeviceKeySettings } from "./src/components/settings/CtoxDeviceKeyRow";
import { SettingsSection } from "./src/components/settings/settingsLayout";
import "./src/index.css";
const bridge = {
 deviceStatus: () => fetch("/__device-status").then(r => r.json()),
 resetDevice: () => fetch("/__device-status", {method:"POST"}).then(r => r.json()),
};
createRoot(document.getElementById("root")).render(<main className="mx-auto max-w-4xl px-4 py-8 sm:px-8"><h1 className="mb-7 text-2xl font-semibold">Einstellungen</h1><SettingsSection title="Konto · ctox.dev"><CtoxDeviceKeySettings bridge={bridge}/></SettingsSection></main>);
`;
const server = await createServer({
  configFile: false,
  root: NodePath.join(repo, "apps/web"),
  resolve: { alias: { "~": NodePath.join(repo, "apps/web/src") } },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "device-key-isolated-fixture",
      resolveId(id) {
        if (id === "/__device-key-fixture.tsx") return fixtureModule;
      },
      load(id) {
        if (id === fixtureModule) return source;
      },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url === "/__device-status") {
            if (request.method === "POST") {
              resets++;
              status = { ...status, createdAt: "2026-10-11T17:01:00Z" };
            }
            response.setHeader("content-type", "application/json");
            response.setHeader("cache-control", "no-store");
            response.end(JSON.stringify(status));
            return;
          }
          if (request.url === "/__device-key-fixture") {
            response.setHeader("content-type", "text/html");
            void vite.transformIndexHtml(
                request.url,
                '<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workjet · isoliertes Geräteschlüssel-Prüfprofil</title></head><body><div id="root"></div><script type="module" src="/__device-key-fixture.tsx"></script></body></html>',
              ).then((html) => response.end(html)).catch(next);
            return;
          }
          next();
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
});
let browser;
const errors = [];
try {
  await server.listen();
  const address = server.httpServer.address();
  NodeAssert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/__device-key-fixture`;
  browser = await chromium.launch({
    executablePath: process.env.DEVICE_UI_BROWSER ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    errors.push(
      `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
    ),
  );
  await page.goto(url);
  await page.getByText(/Geräteschlüssel: aktiv seit/).waitFor();
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 900 });
    NodeAssert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `overflow at ${width}`,
    );
    await page.screenshot({ path: NodePath.join(output, `device-key-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Geräteschlüssel-Menü" }).click();
  await page.getByRole("menuitem", { name: "Neu einrichten" }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="ctox-device-key-row"]')?.textContent.includes("19:01"),
  );
  NodeAssert.equal(resets, 1);
  await page.reload();
  await page.getByText(/Geräteschlüssel: aktiv seit.*19:01/).waitFor();
  status = { state: "not_configured", notice: "DEVICE_KEY_LIMIT_REACHED" };
  await page.reload();
  await page.getByText("Geräteschlüssel-Limit erreicht").waitFor();
  NodeAssert.equal(await page.getByRole("dialog").count(), 0);
  await page.screenshot({ path: NodePath.join(output, "device-key-limit-420.png"), fullPage: true });
  const fresh = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const freshPage = await fresh.newPage();
  await freshPage.goto(url);
  await freshPage.getByText("Geräteschlüssel: nicht eingerichtet").waitFor();
  await fresh.close();
  await context.close();
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "browser-result.json"),
    JSON.stringify(
      {
        pass: true,
        profile: "isolated public-metadata fixture",
        widths: [1440, 420],
        stories: [
          "active lifecycle",
          "reconfigure once",
          "reload persisted result",
          "quota notice without dialog",
          "fresh profile unconfigured",
          "no horizontal overflow",
        ],
        errors,
        resets,
      },
      null,
      2,
    ),
  );
  process.stdout.write("DEVICE_KEY_SETTINGS_BROWSER_OK\n");
} finally {
  await browser?.close();
  await server.close();
}
