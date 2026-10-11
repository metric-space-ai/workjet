import * as Assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as FS from "node:fs/promises";
import { createRequire } from "node:module";
import * as Path from "node:path";
const repo = Path.resolve(import.meta.dirname, "..");
const require = createRequire(Path.join(repo, "apps/desktop/package.json"));
const { chromium } = require("playwright-core");
const output = process.env.SUPERVISOR_TICK_ARTIFACT_DIR;
Assert.ok(output, "SUPERVISOR_TICK_ARTIFACT_DIR must be an owned directory");
await FS.mkdir(output, { recursive: true });
const profile = await FS.mkdtemp(Path.join(process.env.TMPDIR, "supervisor-tick-browser-"));
const title = "Kontrollrunde Prüfprojekt";
let server, browser;
const errors = [];
const launched = [];
async function command(args) {
  const child = spawn(process.execPath, args, {
    cwd: repo,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  launched.push({ pid: child.pid, purpose: args[0] });
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    text += chunk;
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(text.slice(-6000)))));
  });
}
try {
  await command([
    "apps/server/src/bin.ts",
    "project",
    "add",
    repo,
    "--base-dir",
    profile,
    "--title",
    title,
  ]);
  server = spawn(process.execPath, ["scripts/dev-runner.ts", "dev", "--home-dir", profile], {
    cwd: repo,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  launched.push({ pid: server.pid, purpose: "isolated Workjet web stack" });
  await FS.writeFile(
    Path.join(output, "processes.json"),
    JSON.stringify({
      owner: process.env.BUILD_LANE_OWNER,
      profile,
      launched,
      stopCondition: "browser verification complete",
    }),
  );
  const pairing = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            "Dev stack startup exceeded 90 seconds: " +
              buffer.replace(/token=[^\s"']+/g, "token=REDACTED").slice(-6000),
          ),
        ),
      90000,
    );
    const read = (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-32000);
      const match = buffer.match(
        /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/pair#token=[A-Za-z0-9._~-]+/,
      );
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };
    server.stdout.on("data", read);
    server.stderr.on("data", read);
    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          "Dev stack exited: " +
            code +
            " " +
            buffer.replace(/token=[^\s"']+/g, "token=REDACTED").slice(-6000),
        ),
      );
    });
  });
  browser = await chromium.launch({
    executablePath: process.env.SUPERVISOR_TICK_CHROME_PATH ?? "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pairing);
  await page
    .getByRole("button", { name: "Open " + title, exact: true })
    .waitFor({ timeout: 60000 });
  const origin = new URL(pairing).origin;
  async function overview(width) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin);
    await page.getByRole("button", { name: "Open " + title, exact: true }).click();
    await page.locator("[data-workjet-supervisor-tick]").waitFor();
    Assert.match(
      await page.locator("[data-workjet-supervisor-tick]").innerText(),
      /Letzte Kontrolle:.*Nächste:/s,
    );
    Assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "overview horizontal overflow",
    );
    await page.screenshot({
      path: Path.join(output, "overview-" + width + ".png"),
      fullPage: true,
    });
  }
  async function settings(width) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin);
    await page.getByRole("button", { name: "Project actions for " + title, exact: true }).click();
    await page.getByRole("menuitem", { name: "Configure " + title, exact: true }).click();
    const editor = page.locator("[data-workjet-project-overview-editor]");
    await editor.waitFor();
    const interval = editor.getByRole("spinbutton", { name: "Supervisor-Takt in Minuten" });
    Assert.equal(await interval.inputValue(), "30");
    await page.screenshot({
      path: Path.join(output, "settings-" + width + ".png"),
      fullPage: true,
    });
    Assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "settings horizontal overflow",
    );
    return editor;
  }
  await overview(1440);
  await overview(420);
  const wide = await settings(1440);
  await wide.getByRole("button", { name: "Cancel", exact: true }).click();
  const narrow = await settings(420);
  await narrow.getByRole("spinbutton", { name: "Supervisor-Takt in Minuten" }).fill("45");
  const enabled = narrow.getByRole("checkbox");
  await enabled.uncheck();
  await narrow.getByRole("button", { name: "Save project", exact: true }).click();
  await page.locator("[data-workjet-project-overview-editor]").waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("button", { name: "Project actions for " + title, exact: true }).click();
  await page.getByRole("menuitem", { name: "Configure " + title, exact: true }).click();
  const restored = page.locator("[data-workjet-project-overview-editor]");
  Assert.equal(
    await restored.getByRole("spinbutton", { name: "Supervisor-Takt in Minuten" }).inputValue(),
    "45",
  );
  Assert.equal(await restored.getByRole("checkbox").isChecked(), false);
  await restored.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Open " + title, exact: true }).click();
  await page.getByText("Nächste: aus", { exact: true }).waitFor();
  Assert.deepEqual(errors, []);
  await FS.writeFile(
    Path.join(output, "result.json"),
    JSON.stringify(
      {
        pass: true,
        profile: "isolated disposable",
        viewports: [1440, 420],
        checks: [
          "overview countdown",
          "settings defaults",
          "off and 45 minutes persist after reload",
          "overview off",
          "no horizontal overflow",
          "no browser errors",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "SUPERVISOR_TICK_BROWSER_PASS: overview/settings 1440+420; server-backed save/reload; disabled countdown",
  );
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGINT");
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 10000);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    Assert.notEqual(server.exitCode, null, "Owned dev stack must stop on SIGINT");
  }
  await FS.rm(profile, { recursive: true, force: true });
  await FS.writeFile(
    Path.join(output, "processes.json"),
    JSON.stringify({
      owner: process.env.BUILD_LANE_OWNER,
      launched,
      stopped: true,
      profileRemoved: true,
    }),
  );
}
