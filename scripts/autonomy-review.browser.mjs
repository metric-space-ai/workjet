import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as ChildProcess from "node:child_process";
const repo = NodePath.resolve(import.meta.dirname, "..");
const desktopRequire = NodeModule.createRequire(NodePath.join(repo, "apps/desktop/package.json"));
const { chromium } = desktopRequire("playwright-core");
const output = process.env.AUTONOMY_UI_OUTPUT,
  profile = process.env.AUTONOMY_UI_PROFILE;
NodeAssert.ok(output && profile, "Owned profile/output required");
await NodeFS.mkdir(output, { recursive: true });
let browser,
  server,
  log = "";
try {
  server = ChildProcess.spawn(
    process.execPath,
    [
      "apps/server/src/bin.ts",
      "serve",
      "--base-dir",
      profile,
      "--host",
      "127.0.0.1",
      "--port",
      "38423",
      "--no-browser",
    ],
    {
      cwd: repo,
      env: { ...process.env, WORKJET_HOME: profile },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  console.log(
    "AUTONOMY_UI_SERVER owner=01a12a9a-e637-7c80-bc35-100569b8f040 pid=" +
      server.pid +
      " stop=finally",
  );
  const pairing = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            "Server pairing URL timeout: " + log.replace(/token=[^&\s]+/g, "token=REDACTED"),
          ),
        ),
      45000,
    );
    const receive = (data) => {
      log += data.toString();
      const url = log.match(/http:\/\/127\.0\.0\.1:38423[^\s"<>]*[#?&]token=[^\s"<>]+/);
      if (url) {
        clearTimeout(timeout);
        resolve(url[0]);
      }
    };
    server.stdout.on("data", receive);
    server.stderr.on("data", receive);
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Server exited " + code + ": " + log.slice(-4000)));
    });
  });
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "de-DE" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  await page.goto(pairing);
  await page.getByText("Autonomie-Prüfung", { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByText("Autonomie-Prüfung", { exact: false }).first().click();
  await page
    .getByText("wartet auf Supervisor", { exact: false })
    .first()
    .waitFor({ timeout: 15000 });
  await page.screenshot({
    path: NodePath.join(output, "worker-overview-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.screenshot({ path: NodePath.join(output, "worker-overview-420.png"), fullPage: true });
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("http://127.0.0.1:38423/#/autonomy-review/autonomy-supervisor");
    await page
      .getByText("Welcher freigegebene Weg", { exact: false })
      .first()
      .waitFor({ timeout: 15000 });
    await page.screenshot({
      path: NodePath.join(output, "supervisor-question-" + width + ".png"),
      fullPage: true,
    });
  }
  await NodeFS.writeFile(
    NodePath.join(output, "browser-evidence.json"),
    JSON.stringify(
      { pass: true, widths: [1440, 420], profile: "isolated", actualRouting: true, errors },
      null,
      2,
    ),
  );
  NodeAssert.deepEqual(errors, []);
  console.log("AUTONOMY_UI_PASS 1440 420 actual-routing supervisor-question");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (server.exitCode === null) server.kill("SIGKILL");
        resolve();
      }, 5000);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await NodeFS.writeFile(
    NodePath.join(output, "server-redacted.log"),
    log.replace(/token=[^&\s]+/g, "token=REDACTED"),
  );
}
