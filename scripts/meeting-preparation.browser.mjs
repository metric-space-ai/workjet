import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";

if (!process.env.TMPDIR || !process.env.CARGO_TARGET_DIR)
  throw new Error("Use the owned build lane.");
const { chromium } = await import(process.env.WORKJET_PREPARATION_PLAYWRIGHT_MODULE_PATH);
const directory = NodePath.join(process.env.CARGO_TARGET_DIR, "preparation-ui-proof");
await NodeFSP.mkdir(directory, { recursive: true });
const owned = [];
async function launch(command, args, cwd, extra = {}) {
  const log = await NodeFSP.open(NodePath.join(directory, "process-" + owned.length + ".log"), "w");
  const child = NodeChildProcess.spawn(command, args, {
    cwd,
    env: { ...process.env, ...extra },
    stdio: ["ignore", log.fd, log.fd],
    detached: true,
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  owned.push({ child, closed, log });
}
let browser;
let deadline;
try {
  deadline = setTimeout(() => {
    for (const { child } of owned) if (child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  }, 300000);
  await launch(
    process.execPath,
    ["apps/server/scripts/project-token-budget-fixture.ts"],
    process.cwd(),
    {
      WORKJET_BUDGET_FIXTURE_HOME: NodePath.join(process.env.TMPDIR, "preparation-profile"),
      WORKJET_BUDGET_FIXTURE_PORT: "19081",
    },
  );
  await launch(
    "corepack",
    ["pnpm", "exec", "vp", "dev", "--config", "vite.preparation-fixture.config.ts"],
    NodePath.join(process.cwd(), "apps/web"),
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "owned-processes.json"),
    JSON.stringify(
      owned.map(({ child }) => ({
        owner: "01a12aa3-6a3a-7f51-b3d0-454a55dd7135",
        pid: child.pid,
        purpose: "isolated preparation settings",
        stopCondition: "finally, maximum five minutes",
      })),
    ),
  );
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.setDefaultTimeout(30000);
  for (let attempt = 0; ; attempt++) {
    try {
      const responses = await Promise.all([
        fetch("http://127.0.0.1:19082/token-budget.fixture.html"),
        fetch("http://127.0.0.1:19081/fixture-budget"),
      ]);
      if (responses.every((r) => r.ok)) break;
    } catch {}
    if (owned.some(({ child }) => child.exitCode !== null))
      throw new Error("Fixture process exited; inspect owned logs.");
    if (attempt >= 60) throw new Error("Readiness deadline.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await page.goto("http://127.0.0.1:19082/token-budget.fixture.html");
  await page.getByRole("button", { name: "Projekt-Einstellungen", exact: true }).click();
  const harness = () => page.getByLabel("Vorbereitungs-Harness");
  const enabled = () => page.getByLabel("Vorbereitung aktiv");
  await harness().waitFor();
  NodeAssert.equal(await harness().inputValue(), "claude-code");
  NodeAssert.equal(await page.getByLabel("Vorbereitungs-Modell").inputValue(), "grok-4.7");
  for (const h of ["grok-cli", "opencode", "pi-code"])
    NodeAssert.equal(
      await harness()
        .locator('option[value="' + h + '"]')
        .evaluate((option) => option.disabled),
      true,
    );
  NodeAssert.equal(await page.getByLabel("Vorbereitung 1 Stunden vorher").inputValue(), "24");
  NodeAssert.equal(await page.getByLabel("Vorbereitung 2 Stunden vorher").inputValue(), "2");
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: NodePath.join(directory, "settings-" + width + ".png"),
      fullPage: true,
    });
    NodeAssert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  async function save() {
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/fixture-budget") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const saved = await response;
    NodeAssert.equal(saved.status(), 200);
    return (await saved.json()).overview.meetingPreparation;
  }
  await enabled().uncheck();
  await page.getByLabel("Vorbereitung 1 Stunden vorher").fill("12");
  NodeAssert.deepEqual(await save(), {
    enabled: false,
    harness: "claude-code",
    model: "grok-4.7",
    leadMinutes: [720, 120],
  });
  await page.reload();
  await page.getByRole("button", { name: "Projekt-Einstellungen", exact: true }).click();
  NodeAssert.equal(await enabled().isChecked(), false);
  NodeAssert.equal(await page.getByLabel("Vorbereitung 1 Stunden vorher").inputValue(), "12");
  await enabled().check();
  await page.getByLabel("Vorbereitung 1 Stunden vorher").fill("24");
  NodeAssert.equal((await save()).enabled, true);
  await page.reload();
  await page.getByRole("button", { name: "Projekt-Einstellungen", exact: true }).click();
  NodeAssert.equal(await enabled().isChecked(), true);
  NodeAssert.equal(errors.length, 0, errors.join("\n"));
  await NodeFSP.writeFile(
    NodePath.join(directory, "result.json"),
    JSON.stringify(
      {
        pass: true,
        viewports: [1440, 420],
        cases: [
          "default",
          "disabled harness reasons",
          "off/on",
          "custom lead time",
          "save and reload",
          "responsive overflow",
        ],
        fixture: "real ProjectOverviewEditor and project engine in isolated loopback profile",
        installedAcceptance: false,
        errors,
      },
      null,
      2,
    ),
  );
  console.log("PREPARATION_UI_PASS", directory);
} finally {
  clearTimeout(deadline);
  await browser?.close();
  for (const { child } of owned)
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  await Promise.race([
    Promise.all(owned.map(({ closed }) => closed)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  for (const { child } of owned)
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  await Promise.all(owned.map(({ closed }) => closed));
  await NodeFSP.writeFile(
    NodePath.join(directory, "cleanup.json"),
    JSON.stringify({
      processes: owned.map(({ child }) => ({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      })),
      browserClosed: true,
    }),
  );
  for (const { log } of owned) await log.close();
}
