// Screenshots every QA case (light and dark) into output/slide-engine-scenes/ and checks that
// idle business scenes schedule no animation frames. Run qa/build-scenes-qa.mjs first.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const qaDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoDir = NodePath.resolve(qaDir, "../../..");
const outDir = NodePath.join(repoDir, "output/slide-engine-scenes");
const pageUrl = NodeURL.pathToFileURL(NodePath.join(qaDir, "scenes.html")).href;
const chrome =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function loadPlaywright() {
  for (const base of [NodePath.join(repoDir, "apps/desktop"), repoDir]) {
    try {
      return NodeModule.createRequire(NodePath.join(base, "package.json"))("playwright-core");
    } catch {
      // try the next location
    }
  }
  const store = process.env.SLIDE_ENGINE_QA_PNPM_STORE;
  const entry =
    store && NodeFS.readdirSync(store).find((dir) => dir.startsWith("playwright-core@"));
  if (entry)
    return NodeModule.createRequire(import.meta.url)(
      NodePath.join(store, entry, "node_modules/playwright-core"),
    );
  throw new Error("playwright-core not found; run pnpm install first");
}

const { chromium } = loadPlaywright();
NodeFS.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const summary = { page: pageUrl, cases: [], checks: {}, consoleErrors: [], failedRequests: [] };

async function openPage(query, { reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") summary.consoleErrors.push(`${query}: ${message.text()}`);
  });
  page.on("pageerror", (error) => summary.consoleErrors.push(`${query}: ${error.message}`));
  page.on("requestfailed", (request) =>
    summary.failedRequests.push(`${query}: ${request.url().slice(0, 120)}`),
  );
  await page.goto(`${pageUrl}?${query}`);
  await page.waitForSelector(".qa-case");
  return { context, page };
}

/**
 * Scrolls a case into view (scenes only start near the viewport) and waits until a wide scene
 * shows its WebGL canvas and the intro has finished. Returns the figure's mode.
 */
async function showCase(page, id) {
  const section = page.locator(`[data-case="${id}"]`);
  await section.scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (caseId) => {
      const figure = document.querySelector(`[data-case="${caseId}"] figure`);
      if (!figure) return false;
      const mode = figure.getAttribute("data-scene-mode");
      return mode !== "fallback" || figure.clientWidth < 280;
    },
    id,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(2600);
  return section.locator("figure").getAttribute("data-scene-mode");
}

async function caseIds(page) {
  return page.$$eval(".qa-case", (sections) =>
    sections.map((section) => section.getAttribute("data-case")),
  );
}

async function framesDuring(page, ms, action) {
  const before = await page.evaluate(() => window.__qaRafCount);
  if (action) await action();
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => window.__qaRafCount)) - before;
}

for (const theme of ["light", "dark"]) {
  const { context, page } = await openPage(`theme=${theme}`);
  for (const id of await caseIds(page)) {
    const mode = await showCase(page, id);
    const path = NodePath.join(outDir, `${theme}-${id}.png`);
    await page.locator(`[data-case="${id}"] .qa-frame`).screenshot({ path });
    summary.cases.push({ theme, id, mode, file: NodePath.relative(repoDir, path) });
  }
  // Toggles: hide previous values / the target and capture the result.
  for (const [id, label] of [
    ["kpi-960", "Vorwert zeigen"],
    ["trend-960", "Ziel zeigen"],
  ]) {
    await showCase(page, id);
    const frame = page.locator(`[data-case="${id}"] .qa-frame`);
    await frame.getByRole("button", { name: label }).click();
    await page.waitForTimeout(300);
    const path = NodePath.join(outDir, `${theme}-${id}-toggled.png`);
    await frame.screenshot({ path });
    summary.cases.push({
      theme,
      id: `${id}-toggled`,
      mode: "live",
      file: NodePath.relative(repoDir, path),
    });
    await frame.getByRole("button", { name: label }).click();
  }
  // Orbit: drag inside the KPI scene, screenshot, then double click to reset.
  await showCase(page, "kpi-960");
  const port = page.locator('[data-case="kpi-960"] .lb-scene3d-port');
  const box = await port.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const path = NodePath.join(outDir, `${theme}-kpi-960-orbit.png`);
    await page.locator('[data-case="kpi-960"] .qa-frame').screenshot({ path });
    summary.cases.push({
      theme,
      id: "kpi-960-orbit",
      mode: "live",
      file: NodePath.relative(repoDir, path),
    });
    await port.dblclick();
  }
  await context.close();
}

// Render on demand: without the (continuously animated) lecture scene, an idle page schedules
// no frames; a drag schedules frames only while it lasts.
{
  const { context, page } = await openPage("theme=light&only=business");
  await showCase(page, "kpi-960");
  await showCase(page, "trend-960");
  const idle = await framesDuring(page, 1500);
  const port = page.locator('[data-case="trend-960"] .lb-scene3d-port');
  const box = await port.boundingBox();
  const drag = box
    ? await framesDuring(page, 100, async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 160, box.y + box.height / 2, { steps: 10 });
        await page.mouse.up();
      })
    : -1;
  const afterDrag = await framesDuring(page, 1000);
  summary.checks.renderOnDemand = {
    idleFramesIn1500ms: idle,
    framesDuringDrag: drag,
    idleFramesAfterDragIn1000ms: afterDrag,
  };
  await context.close();
}

// Reduced motion: no intro animation, the scene is complete with its first frame.
{
  const { context, page } = await openPage("theme=light&only=business", {
    reducedMotion: "reduce",
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-case="kpi-960"] figure')?.getAttribute("data-scene-mode") ===
      "live",
    null,
    { timeout: 20_000 },
  );
  const frames = await framesDuring(page, 800);
  const path = NodePath.join(outDir, "light-kpi-960-reduced-motion.png");
  await page.locator('[data-case="kpi-960"] .qa-frame').screenshot({ path });
  summary.checks.reducedMotion = {
    framesIn800msAfterLive: frames,
    file: NodePath.relative(repoDir, path),
  };
  await context.close();
}

await browser.close();
NodeFS.writeFileSync(
  NodePath.join(outDir, "qa-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary.checks));
console.log(
  `${summary.cases.length} screenshots in ${NodePath.relative(repoDir, outDir)}; console errors: ${summary.consoleErrors.length}`,
);
for (const error of summary.consoleErrors) console.log(`  ${error}`);
for (const failed of new Set(summary.failedRequests)) console.log(`  failed request ${failed}`);
const live = summary.cases.filter((entry) => entry.mode === "live").length;
if (!live) {
  console.error("no business scene reached live WebGL mode");
  process.exitCode = 1;
}
