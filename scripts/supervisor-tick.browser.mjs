import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
const repo = NodePath.resolve(import.meta.dirname, "..");
const require = NodeModule.createRequire(NodePath.join(repo, "apps/desktop/package.json"));
const { chromium } = require("playwright-core");
const output = process.env.SUPERVISOR_TICK_ARTIFACT_DIR;
NodeAssert.ok(output, "SUPERVISOR_TICK_ARTIFACT_DIR must be an owned directory");
await NodeFSP.mkdir(output, { recursive: true });
const profile = await NodeFSP.mkdtemp(
  NodePath.join(process.env.TMPDIR, "supervisor-tick-browser-"),
);
const title = "Kontrollrunde Prüfprojekt";
let server, browser;
const errors = [];
const launched = [];
async function command(args) {
  const child = NodeChildProcess.spawn(process.execPath, args, {
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
  server = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/dev-runner.ts", "dev", "--home-dir", profile],
    {
      cwd: repo,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  launched.push({ pid: server.pid, purpose: "isolated Workjet web stack" });
  await NodeFSP.writeFile(
    NodePath.join(output, "processes.json"),
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
    ignoreDefaultArgs: true,
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--password-store=basic",
      "--remote-debugging-pipe",
      "--user-data-dir=" + NodePath.join(profile, "chromium"),
    ],
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
    NodeAssert.match(
      await page.locator("[data-workjet-supervisor-tick]").innerText(),
      /Letzte Kontrolle:.*Nächste:/s,
    );
    NodeAssert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "overview horizontal overflow",
    );
    await page.screenshot({
      path: NodePath.join(output, "overview-" + width + ".png"),
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
    NodeAssert.equal(await interval.inputValue(), "30");
    await page.screenshot({
      path: NodePath.join(output, "settings-" + width + ".png"),
      fullPage: true,
    });
    NodeAssert.equal(
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
  NodeAssert.equal(
    await restored.getByRole("spinbutton", { name: "Supervisor-Takt in Minuten" }).inputValue(),
    "45",
  );
  NodeAssert.equal(await restored.getByRole("checkbox").isChecked(), false);
  await restored.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Open " + title, exact: true }).click();
  await page.getByText("Nächste: aus", { exact: true }).waitFor();
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "result.json"),
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
    process.kill(-server.pid, "SIGINT");
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 10000);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    NodeAssert.notEqual(server.exitCode, null, "Owned dev stack must stop on SIGINT");
  }
  await NodeFSP.rm(profile, { recursive: true, force: true });
  await NodeFSP.writeFile(
    NodePath.join(output, "processes.json"),
    JSON.stringify({
      owner: process.env.BUILD_LANE_OWNER,
      launched,
      stopped: true,
      profileRemoved: true,
    }),
  );
}
