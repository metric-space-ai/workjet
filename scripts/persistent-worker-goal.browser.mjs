import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const repo = resolve(import.meta.dirname, "..");
const webRequire = createRequire(resolve(repo, "apps/web/package.json"));
const desktopRequire = createRequire(resolve(repo, "apps/desktop/package.json"));
const { createServer } = await import(pathToFileURL(webRequire.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve("@vitejs/plugin-react")).href);
const { default: tailwind } = await import(pathToFileURL(webRequire.resolve("@tailwindcss/vite")).href);
const { chromium } = await import(pathToFileURL(desktopRequire.resolve("playwright-core")).href);
const output = process.env.UX009_ARTIFACT_DIR;
assert(output, "UX009_ARTIFACT_DIR must name the owned evidence directory");
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root: resolve(repo, "apps/web"), plugins: [react(), tailwind()],
  resolve: { alias: { "~": resolve(repo, "apps/web/src") } },
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ?
    route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${address.port}/persistent-worker-goal-fixture.html`);
  await page.getByText("Ziel noch nicht gesetzt", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Ziel festlegen", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Zieldefinition" });
  await field.fill("Rendering-Latenz anhand des echten Benchmarks senken.");
  await page.getByRole("button", { name: "Ziel setzen und starten" }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(await field.inputValue(), "Rendering-Latenz anhand des echten Benchmarks senken.");
  await page.getByRole("button", { name: "Ziel setzen und starten" }).click();
  await page.getByRole("button", { name: "Pausieren", exact: true }).waitFor();
  await page.locator('[data-slide-id="iteration-2"]').waitFor();
  await page.screenshot({ path: resolve(output, "goal-board-1000.png"), fullPage: true });
  await page.getByRole("button", { name: "Pausieren", exact: true }).click();
  await page.getByText("Pausiert · Durchlauf 0", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Ziel ändern", exact: true }).click();
  await field.fill("Das gespeicherte Ziel bleibt beim Ändern pausiert.");
  await page.getByRole("button", { name: "Ziel speichern", exact: true }).click();
  await page.getByText("Pausiert · Durchlauf 0", { exact: false }).waitFor();
  await page.reload();
  await page.getByText("Das gespeicherte Ziel bleibt beim Ändern pausiert.", { exact: true }).waitFor();
  await page.getByText("Pausiert · Durchlauf 0", { exact: false }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, "goal-board-390.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("UX009_BROWSER_PASS: unset goal; failed save retains draft; save; pause; paused edit; reload; canonical board; 390px");
} finally {
  await browser?.close();
  await server.close();
}
