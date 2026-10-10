import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const repo = NodePath.resolve(import.meta.dirname, "..");
const webRequire = NodeModule.createRequire(NodePath.resolve(repo, "apps/web/package.json"));
const desktopRequire = NodeModule.createRequire(
  NodePath.resolve(repo, "apps/desktop/package.json"),
);
const { createServer } = await import(NodeURL.pathToFileURL(webRequire.resolve("vite")).href);
const { default: react } = await import(
  NodeURL.pathToFileURL(webRequire.resolve("@vitejs/plugin-react")).href
);
const { default: tailwind } = await import(
  NodeURL.pathToFileURL(webRequire.resolve("@tailwindcss/vite")).href
);
const { chromium } = desktopRequire("playwright-core");
const output = process.env.UX009_ARTIFACT_DIR;
NodeAssert.ok(output, "UX009_ARTIFACT_DIR must name the owned evidence directory");
await NodeFSP.mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root: NodePath.resolve(repo, "apps/web"),
  plugins: [react(), tailwind()],
  resolve: { alias: { "~": NodePath.resolve(repo, "apps/web/src") } },
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  NodeAssert.ok(address && typeof address !== "string");
  browser = await chromium.launch({
    executablePath: process.env.UX009_CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--enable-logging=stderr"],
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  await page.goto(`http://127.0.0.1:${address.port}/persistent-worker-goal-fixture.html`);
  await page.getByText("Ziel noch nicht gesetzt", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Ziel festlegen", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Zieldefinition" });
  await field.fill("Rendering-Latenz anhand des echten Benchmarks senken.");
  await page.getByRole("button", { name: "Ziel setzen und starten" }).click();
  await page.getByRole("alert").waitFor();
  NodeAssert.equal(
    await field.inputValue(),
    "Rendering-Latenz anhand des echten Benchmarks senken.",
  );
  await page.getByRole("button", { name: "Ziel setzen und starten" }).click();
  await page.getByRole("button", { name: "Pausieren", exact: true }).waitFor();
  await page.locator('[data-slide-id="iteration-2"]').waitFor();
  await page.screenshot({ path: NodePath.resolve(output, "goal-board-1000.png"), fullPage: true });
  await page.getByRole("button", { name: "Pausieren", exact: true }).click();
  await page.getByText("Pausiert · Durchlauf 0", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Ziel ändern", exact: true }).click();
  await field.fill("Das gespeicherte Ziel bleibt beim Ändern pausiert.");
  await page.getByRole("button", { name: "Ziel speichern", exact: true }).click();
  await page.getByText("Pausiert · Durchlauf 0", { exact: false }).waitFor();
  await page.reload();
  await page
    .getByText("Das gespeicherte Ziel bleibt beim Ändern pausiert.", { exact: true })
    .waitFor();
  await page.getByText("Pausiert · Durchlauf 0", { exact: false }).waitFor();
  await page.locator('[data-slide-id="iteration-2"]').waitFor();
  const contrast = await page
    .locator("th")
    .first()
    .evaluate((header) => {
      const style = getComputedStyle(header);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas color sampler unavailable");
      const luminance = (color) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const data = context.getImageData(0, 0, 1, 1).data;
        const rgb = [...data].slice(0, 3).map((value) => {
          const fraction = value / 255;
          return fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      };
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  NodeAssert.ok(contrast >= 4.5, `Kanban heading contrast ${contrast}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: NodePath.resolve(output, "goal-board-390.png"), fullPage: true });
  NodeAssert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  NodeAssert.deepEqual(errors, []);
  console.log(
    "UX009_BROWSER_PASS: unset goal; failed save retains draft; save; pause; paused edit; reload; canonical board; 390px",
  );
} finally {
  await browser?.close();
  await server.close();
}
