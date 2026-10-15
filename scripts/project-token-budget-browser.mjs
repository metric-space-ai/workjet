import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";

if (!process.env.TMPDIR || !process.env.CARGO_TARGET_DIR)
  throw new Error("Run only on the owned build lane.");
const { chromium } = await import(process.env.WORKJET_BUDGET_PLAYWRIGHT_MODULE_PATH);
const directory = NodePath.join(process.env.CARGO_TARGET_DIR, "budget-ui-proof");
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
  return child;
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
    { WORKJET_BUDGET_FIXTURE_HOME: NodePath.join(process.env.TMPDIR, "budget-fixture-profile") },
  );
  await launch(
    "corepack",
    ["pnpm", "exec", "vp", "dev", "--config", "vite.budget-fixture.config.ts"],
    NodePath.join(process.cwd(), "apps/web"),
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "owned-processes.json"),
    JSON.stringify(
      owned.map(({ child }) => ({
        owner: "01a12952-7b0e-71b2-a1d9-8a37e74ba3a9",
        pid: child.pid,
        purpose: "isolated budget UI proof",
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
        fetch("http://127.0.0.1:18782/token-budget.fixture.html"),
        fetch("http://127.0.0.1:18781/fixture-budget"),
      ]);
      if (responses.every((response) => response.ok)) break;
    } catch {}
    if (owned.some(({ child }) => child.exitCode !== null))
      throw new Error("Owned fixture process exited; inspect process logs.");
    if (attempt >= 60) throw new Error("Fixture readiness deadline reached");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await page.goto("http://127.0.0.1:18782/token-budget.fixture.html");
  const settings = () => page.getByRole("button", { name: "Projekt-Einstellungen", exact: true });
  const overview = () => page.getByRole("button", { name: "Übersicht", exact: true });
  const input = () => page.getByLabel("Token-Budget je Zyklus");
  const budget = () => page.locator("[data-workjet-token-budget]");
  await settings().waitFor();
  await budget().waitFor();
  NodeAssert.match(await budget().innerText(), /1\.8\/2\.3B \(78 %\)/);
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: NodePath.join(directory, "overview-" + width + ".png"),
      fullPage: true,
    });
    await settings().click();
    await input().waitFor();
    NodeAssert.equal(await input().inputValue(), "2,3");
    await page.screenshot({
      path: NodePath.join(directory, "settings-" + width + ".png"),
      fullPage: true,
    });
    NodeAssert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await overview().click();
    NodeAssert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  async function save(value) {
    await input().fill(value);
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/fixture-budget") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const saved = await response;
    NodeAssert.equal(saved.status(), 200);
    return saved.json();
  }
  await settings().click();
  for (const value of ["2,3", "2.3"]) {
    NodeAssert.equal((await save(value)).overview.tokenBudget.limitBillions, 2.3);
    await page.reload();
    await settings().click();
    NodeAssert.equal(await input().inputValue(), "2,3");
  }
  NodeAssert.equal((await save("")).overview.tokenBudget.limitBillions, null);
  await overview().click();
  NodeAssert.equal(await budget().innerText(), "1.8B");
  await settings().click();
  await save("1,0");
  await overview().click();
  NodeAssert.match(await budget().innerText(), /180 %/);
  NodeAssert.match(await budget().getAttribute("class"), /amber/);
  await budget().hover();
  await page.getByText("Token-Budget je Zyklus", { exact: true }).waitFor();
  NodeAssert.equal(errors.length, 0, errors.join("\n"));
  await NodeFSP.writeFile(
    NodePath.join(directory, "result.json"),
    JSON.stringify(
      {
        pass: true,
        viewports: [1440, 420],
        cases: [
          "settings",
          "overview",
          "comma and dot persistence",
          "reload",
          "unlimited",
          "overrun without blocking",
          "tooltip",
        ],
        errors,
        fixture: "real project engine and canonical UsageService with sanitized transcript",
        installedAcceptance: false,
      },
      null,
      2,
    ),
  );
  console.log("UI_PROOF_PASS:" + directory);
} catch (error) {
  await NodeFSP.writeFile(
    NodePath.join(directory, "result.json"),
    JSON.stringify({ pass: false, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  clearTimeout(deadline);
  if (browser) await browser.close();
  for (const { child, closed, log } of owned.toReversed()) {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    await closed;
    await log.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(directory, "cleanup.json"),
    JSON.stringify(
      { allOwnedProcessesStopped: true, pids: owned.map(({ child }) => child.pid) },
      null,
      2,
    ),
  );
}
