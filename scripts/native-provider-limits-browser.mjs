import * as ChildProcess from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// Isolated component profile: real native account rows, synthetic metadata, no credentials.
const root = process.cwd();
const output = Path.resolve(process.env.WORKJET_LIMITS_OUTPUT ?? "output/playwright/native-limits");
const fixture = Path.join(root, "apps/web/.workjet/native-limits-review");
const settings = Path.join(root, "apps/web/src/components/settings");
const port = 5841;
const origin = `http://127.0.0.1:${port}`;
const { chromium } = await import(pathToFileURL(process.env.WORKJET_LIMITS_PLAYWRIGHT_MODULE).href);
await FS.mkdir(output, { recursive: true });
await FS.mkdir(fixture, { recursive: true });
const beforePaths = ["NativeProviderLimits", "NativeProviderRows"].map((name) => Path.join(settings, `${name}.before.tsx`));
for (const [index, name] of ["NativeProviderLimits", "NativeProviderRows"].entries()) {
  const source = ChildProcess.execFileSync("git", ["show", `29de99516aadd413803e1a36b0e0f30c880e854e:apps/web/src/components/settings/${name}.tsx`], { encoding: "utf8" });
  await FS.writeFile(beforePaths[index], index === 1 ? source.replace('"./NativeProviderLimits"', '"./NativeProviderLimits.before"') : source);
}
await FS.writeFile(Path.join(fixture, "index.html"), '<!doctype html><html lang="de" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native limits review profile</title></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
await FS.writeFile(Path.join(fixture, "fixture.tsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { NativeProviderRowsView } from "../../src/components/settings/NativeProviderRows";
import { NativeProviderRowsView as BeforeRows } from "../../src/components/settings/NativeProviderRows.before";
const now = Date.now();
const windows = (used, rejected = false) => ({ state: "reported", observedAtMs: now, windows: [
  { kind: "five_hour", status: rejected ? "rejected" : "allowed", resetAtMs: now + 3600000, utilization: used },
  { kind: "seven_day", status: "allowed", resetAtMs: now + 86400000, utilization: 0.25 },
] });
const accounts = [
  ["unused", "claude", 0, false], ["regular", "claude", 0.25, true],
  ["warning", "claude", 0.8, false], ["critical", "claude", 0.95, false],
  ["exhausted", "claude", 1, false], ["missing", "claude", null, true],
  ["direction", "codex", 1, true],
].map(([id, provider, used, rejected]) => ({
  id, provider, holder: { kind: "ctox_instance", id: "isolated-review" }, enabled: true,
  credentialReady: false, revision: 1, reportedQuota: windows(used, rejected),
  modelCatalog: { fresh: false, observed: false, models: [], lastSuccessAtMs: null, lastAttempt: null },
  excludedModels: [], effectiveModels: [], modelChecks: [], inferenceVerified: false,
}));
const state = { registry: { accounts, providers: [] }, busy: false, error: null, errorAccountId: null,
  connectionFailure: null, run: async () => undefined, refresh: async () => undefined, check: async () => undefined };
const View = new URLSearchParams(location.search).get("mode") === "before" ? BeforeRows : NativeProviderRowsView;
createRoot(document.getElementById("root")).render(
  <main className="mx-auto max-w-5xl p-3 sm:p-8">
    <p className="mb-4 text-xs text-muted-foreground">Isoliertes Prüfprofil · synthetische Konten · keine Modellaufrufe</p>
    <h1 className="mb-6 text-2xl font-semibold">Modelle · Instanzkonten</h1>
    <div role="table" aria-label="Instance provider accounts"><View state={state} label="Prüfprofil" /></div>
  </main>
);
`);
let browser;
let log = "";
const server = ChildProcess.spawn("pnpm", ["--dir", "apps/web", "exec", "vp", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, detached: true, env: { ...process.env, WORKJET_SINGLE_ORIGIN_DEV: "1" }, stdio: ["ignore", "pipe", "pipe"] });
const stopServer = (signal) => { try { process.kill(-server.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
const receipt = {
  schema: "workjet.native-limits.synthetic-browser.v1", head: ChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  fixture: "real NativeProviderRowsView; synthetic metadata, empty model lists, no account secrets", owner: process.env.WORKJET_LIMITS_OWNER,
  serverPid: server.pid, stopCondition: "finally stops captured Vite child and closes browser", stories: [], consoleErrors: [], failedRequests: [],
};
const deadline = setTimeout(() => stopServer("SIGTERM"), 180_000);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server not ready: ${log}`)), 60_000);
    const collect = (data) => { log += data; if (log.includes(`:${port}/`)) { clearTimeout(timeout); resolve(); } };
    server.stdout.on("data", collect); server.stderr.on("data", collect);
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${log}`)); });
  });
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  for (const width of [1440, 420]) {
    for (const mode of ["before", "after"]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "de-DE" });
      const page = await context.newPage();
      page.on("pageerror", (error) => receipt.consoleErrors.push({ width, mode, message: error.message }));
      page.on("console", (message) => { if (message.type() === "error") receipt.consoleErrors.push({ width, mode, message: message.text() }); });
      page.on("requestfailed", (request) => receipt.failedRequests.push({ width, mode, url: request.url(), error: request.failure()?.errorText }));
      await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/.workjet/native-limits-review/index.html?mode=${mode}`);
      const table = page.getByRole("table", { name: "Instance provider accounts" });
      await table.waitFor();
      const verify = async () => {
        await table.getByText("Account exhaust", { exact: true }).waitFor();
        if (mode === "before") return;
        const row = (id) => table.getByRole("row").filter({ has: page.getByText(`Account ${id.slice(0, 8)}`, { exact: true }) });
        for (const [id, rest, color] of [["unused", 100, "bg-emerald-500/80"], ["regular", 75, "bg-emerald-500/80"], ["warning", 20, "bg-amber-500"], ["critical", 5, "bg-red-500"], ["exhausted", 0, "bg-red-500"]]) {
          const meter = row(id).getByRole("meter", { name: "Short-term verbleibend" });
          assert.equal(await meter.getAttribute("aria-valuenow"), String(rest));
          assert.equal(await meter.locator("span").getAttribute("style"), `width: ${rest}%;`);
          assert.ok((await meter.locator("span").getAttribute("class")).includes(color));
          assert.equal(await row(id).getByText("Limit reached", { exact: true }).count(), rest === 0 ? 1 : 0);
          assert.equal(await row(id).locator('[title*="5 h"]').count(), 1);
          assert.equal(await row(id).getByText("7 Tage", { exact: true }).count(), 1);
        }
        for (const id of ["missing", "direction"]) {
          assert.ok(await row(id).getByText("unbekannt", { exact: true }).count() > 0);
          assert.equal(await row(id).getByText("Limit reached", { exact: true }).count(), 0);
          assert.equal(await row(id).getByRole("meter", { name: "Short-term verbleibend" }).count(), 0);
        }
        receipt.stories.push({ width, mode, documentOverflowPx: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) });
      };
      await verify();
      await page.reload();
      await table.waitFor();
      await verify();
      const screenshot = `native-limits-${mode}-${width}.png`;
      await page.screenshot({ path: Path.join(output, screenshot), fullPage: true });
      receipt.stories.push({ width, mode, cleanContext: true, reload: true, pass: true, screenshot });
      await context.close();
    }
  }
  assert.deepEqual(receipt.consoleErrors, []); assert.deepEqual(receipt.failedRequests, []);
  receipt.pass = true;
} catch (error) {
  receipt.pass = false; receipt.failure = String(error); throw error;
} finally {
  clearTimeout(deadline); await browser?.close(); stopServer("SIGTERM");
  await new Promise((resolve) => { if (server.exitCode !== null) return resolve(); server.once("exit", resolve); setTimeout(() => { stopServer("SIGKILL"); resolve(); }, 5000).unref(); });
  await FS.writeFile(Path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await FS.writeFile(Path.join(output, "vite.log"), log);
  await FS.rm(fixture, { recursive: true, force: true });
  for (const path of beforePaths) await FS.rm(path, { force: true });
}
console.log(`Native provider limits review passed at 1440/420 px, including reload; ${output}`);
