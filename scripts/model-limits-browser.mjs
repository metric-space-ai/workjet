import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// Component-only review profile: no installed state, account secrets or upstream requests.
const root = process.cwd();
const base = process.env.WORKJET_LIMITS_BASE ?? "origin/main";

const output = path.resolve(process.env.WORKJET_LIMITS_OUTPUT ?? "output/playwright/model-limits");
const fixture = path.join(root, "apps/web/.workjet/limits-review");
const settings = path.join(root, "apps/web/src/components/settings");
const port = 5839;
const origin = `http://127.0.0.1:${port}`;
const { chromium } = await import(pathToFileURL(process.env.WORKJET_LIMITS_PLAYWRIGHT_MODULE).href);
await mkdir(output, { recursive: true });
await mkdir(fixture, { recursive: true });
const beforePaths = ["WorkjetModelsProviders", "WorkjetModelsHealth"].map((name) =>
  path.join(settings, `${name}.before.tsx`),
);
for (const [index, name] of ["WorkjetModelsProviders", "WorkjetModelsHealth"].entries()) {
  await writeFile(
    beforePaths[index],
    execFileSync("git", [
      "show",
      `${base}:apps/web/src/components/settings/${name}.${index === 0 ? "tsx" : "ts"}`,
    ]),
  );
}
await writeFile(
  path.join(fixture, "index.html"),
  '<!doctype html><html lang="de" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic model limits review</title></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
);
await writeFile(
  path.join(fixture, "fixture.tsx"),
  `
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { WorkjetModelsProviders } from "../../src/components/settings/WorkjetModelsProviders";
import { WorkjetModelsProviders as BeforeProviders } from "../../src/components/settings/WorkjetModelsProviders.before";
import { modelsAccountHealth } from "../../src/components/settings/WorkjetModelsHealth";
import { modelsAccountHealth as beforeHealth } from "../../src/components/settings/WorkjetModelsHealth.before";
const now = Date.parse("2026-10-11T10:00:00Z");
const source = (field, value, windowSeconds, status = null) => ({ field, value, windowSeconds, status });
const quota = (name, remainingPercent, raw) => ({ name, remainingPercent, source: raw, resetsAtMs: now + 3600000, observedAtMs: now, modelPattern: null, toolOnly: false, notInPlan: false, unlimited: false, boostPermille: null });
const fixtures = [
  ["claude", "claude@example.test", [quota("five_hour", 100, source("utilization", 0, 18000)), quota("seven_day", 99, source("utilization", 1, 604800))]],
  ["codex", "codex@example.test", [quota("primary_window", 43, source("used_percent", 57, 18000)), quota("secondary_window", 80, source("used_percent", 20, 604800))]],
  ["zai", "zai@example.test", [quota("TOKENS_LIMIT_0", 95, source("percentage", 5, 18000)), quota("TOKENS_LIMIT_1", 58, source("percentage", 42, 604800))]],
  ["minimax", "minimax@example.test", [quota("general_interval", 100, source("current_interval_remaining_percent", 100, 18000, 2)), quota("general_weekly", 0, source("current_weekly_remaining_percent", 0, 604800, 2))]],
  ["xai", "xai@example.test", []],
  ["kimi", "kimi@example.test", []],
];
const mode = new URLSearchParams(location.search).get("mode");
const legacy = mode === "legacy";
const accounts = fixtures.map(([provider, label]) => ({ id: provider, provider, label, enabled: true, priority: 0, weight: 1, modelIds: [], credentialSuffix: null }));
const health = Object.fromEntries(fixtures.map(([provider, label, windows]) => [provider, (mode === "before" ? beforeHealth : modelsAccountHealth)({
  accountId: provider, provider, authentication: "authenticated", disabled: false, usable: true,
  cooldownUntilMs: provider === "minimax" ? now + 3600000 : null,
  errorCode: null, httpStatus: provider === "minimax" ? 429 : 200,
  generationHttpStatus: provider === "minimax" ? 429 : 200, observedAtMs: now,
  quota: legacy ? windows.map(({source, ...window}) => window) : windows, balance: null,
  quotaSupported: windows.length > 0, quotaRefreshing: false, quotaError: null,
}, now)]));
const noop = () => {};
const refused = async () => false;
const state = {
  status: null, catalog: { schemaVersion: 1, accounts, pools: [], routes: [], models: [], routingStrategy: "fill-first", providerPools: [] },
  isInitialLoading: false, isRefreshing: false, statusError: null, catalogError: null, isOperating: false,
  login: { status: "idle" }, apiKey: { status: "idle" }, mutationBusy: false, loginAccountId: null,
  accountErrors: {}, accountHealth: health, modelChecks: [], checksBusy: false,
  onRefresh: noop, onRetry: noop, onAddAccount: noop, onCancelLogin: noop, onAddApiKey: noop,
  onRemoveAccount: noop, onEditAccount: refused, onEditModels: refused, onDeleteAccount: refused,
  onRelogin: noop, onSaveApiKey: refused,
};
const Table = mode === "before" ? BeforeProviders : WorkjetModelsProviders;
createRoot(document.getElementById("root")).render(<main className="mx-auto max-w-5xl p-4 sm:p-8"><p className="mb-5 text-xs text-muted-foreground">Isoliertes Prüfprofil · synthetische Konten · keine Modellaufrufe</p><h1 className="mb-6 text-2xl font-semibold">Einstellungen · Modelle</h1><Table {...state}/></main>);
`,
);
let browser;
let log = "";
const server = spawn(
  "pnpm",
  [
    "--dir",
    "apps/web",
    "exec",
    "vp",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: root,
    detached: true,
    env: { ...process.env, WORKJET_SINGLE_ORIGIN_DEV: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const stopServer = (signal) => {
  try {
    process.kill(-server.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const receipt = {
  schema: "workjet.model-limits.synthetic-browser.v1",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  fixture: "synthetic component review profile; no installed data",
  owner: process.env.WORKJET_LIMITS_OWNER,
  serverPid: server.pid,
  stopCondition: "finally kills only the captured Vite child; browser closes",
  stories: [],
  consoleErrors: [],
  failedRequests: [],
};
const deadline = setTimeout(() => stopServer("SIGTERM"), 180_000);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Fixture server did not become ready")),
      60_000,
    );
    const collect = (data) => {
      log += data;
      if (log.includes(`:${port}/`)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Fixture server exited ${code}: ${log}`));
    });
  });
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  for (const width of [1440, 420]) {
    for (const mode of ["before", "after", "legacy"]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        locale: "de-DE",
      });
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        receipt.consoleErrors.push({ width, mode, message: error.message }),
      );
      page.on("console", (message) => {
        if (message.type() === "error")
          receipt.consoleErrors.push({ width, mode, message: message.text() });
      });
      page.on("requestfailed", (request) =>
        receipt.failedRequests.push({
          width,
          mode,
          url: request.url(),
          error: request.failure()?.errorText,
        }),
      );
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/.workjet/limits-review/index.html?mode=${mode}`);
      await page.getByRole("table", { name: "LLM provider accounts" }).waitFor();
      const assertLimits = async () => {
        const table = page.getByRole("table", { name: "LLM provider accounts" });
        if (mode !== "before") {
          assert.equal(
            await table.getByText(/Usage limit|Short-term limit|Long-term limit/).count(),
            0,
          );
          const mini = table.locator('[data-provider="minimax"]');
          assert.equal(
            await mini.getByText("Limit reached", { exact: true }).count(),
            mode === "after" ? 2 : 1,
          );
          assert.equal(
            await mini.locator('[role="meter"][aria-valuenow="0"]').count(),
            mode === "after" ? 2 : 1,
          );
          assert.equal(
            await table
              .locator('[data-provider="codex"] [role="meter"][aria-valuenow="43"]')
              .count(),
            1,
          );
          for (const provider of ["xai", "kimi"])
            assert.equal(
              await table
                .locator('[data-provider="' + provider + '"] [title="Anbieter meldet kein Limit"]')
                .count(),
              1,
            );
          if (mode === "after") {
            const zai = table.locator('[data-provider="zai"]');
            assert.equal(await zai.getByText("Short-term", { exact: true }).count(), 1);
            assert.equal(await zai.getByText("7 Tage", { exact: true }).count(), 1);
            assert.equal(await table.locator('[data-provider="claude"] [title*="5 h"]').count(), 1);
          } else
            assert.equal(
              await table
                .locator('[data-provider="zai"]')
                .getByText("unbekannt", { exact: true })
                .count(),
              2,
            );
          const overflow = await table.evaluate((node) => node.scrollWidth - node.clientWidth);
          assert(overflow <= 1, `Table overflows ${overflow}px at ${width}`);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
        }
      };
      await assertLimits();
      await page.reload();
      await page.getByRole("table", { name: "LLM provider accounts" }).waitFor();
      await assertLimits();
      const screenshot = path.join(output, `limits-${mode}-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      receipt.stories.push({
        width,
        mode,
        cleanContext: true,
        reload: true,
        pass: true,
        screenshot: path.basename(screenshot),
      });
      await context.close();
    }
  }
  assert.deepEqual(receipt.consoleErrors, []);
  assert.deepEqual(receipt.failedRequests, []);
  receipt.pass = true;
} catch (error) {
  receipt.pass = false;
  receipt.failure = String(error);
  throw error;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  stopServer("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once("exit", resolve);
    setTimeout(() => {
      stopServer("SIGKILL");
      resolve();
    }, 5000).unref();
  });
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await writeFile(path.join(output, "vite.log"), log);
  await rm(fixture, { recursive: true, force: true });
  for (const file of beforePaths) await rm(file, { force: true });
}
console.log(
  `Synthetic browser review passed: ${receipt.stories.length} viewport/host cases, including reload; output ${output}`,
);
