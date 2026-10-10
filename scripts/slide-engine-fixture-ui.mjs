#!/usr/bin/env node
// Browser proof for the slide canvas fixture (apps/web/slide-engine-fixture.html) under the Workjet
// renderer CSP. Fixture only; this does not replace an installed desktop acceptance.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const [modulePath, outputDirectory] = process.argv.slice(2);
if (!modulePath || !outputDirectory)
  throw new Error(
    "Usage: node scripts/slide-engine-fixture-ui.mjs PLAYWRIGHT_MODULE OUTPUT_DIRECTORY",
  );
const FIXTURE_URL = "http://127.0.0.1:5746/slide-engine-fixture.html";
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FRAME = { width: 1600, height: 900 };
const EDIT_FIT_MARGIN = 0.92;
const RECTANGLE = { id: "ideen:box", x: 100, y: 240, width: 480, height: 220 };
const NEW_TEXT = "Neuer Gedanke";
const DRAG_PX = 120;

// Accept a package directory (CommonJS entry) as well as a module file.
const { chromium } = NodeModule.createRequire(import.meta.url)(NodePath.resolve(modulePath));
const output = NodePath.resolve(outputDirectory);
await NodeFSP.mkdir(output, { recursive: true });
const bundled = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const executablePath =
  process.env.WORKJET_FIXTURE_CHROMIUM ??
  (bundled && NodeFS.existsSync(bundled) ? undefined : SYSTEM_CHROME);
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
  ...(executablePath ? { executablePath } : {}),
  args: ["--use-mock-keychain", "--password-store=basic", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.addInitScript(() => {
  window.__fixtureViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__fixtureViolations.push(
      `${event.effectiveDirective} blocked ${event.blockedURI || "inline"} (${event.sourceFile}:${event.lineNumber})`,
    );
  });
});
const consoleErrors = [];
const webglWarnings = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
  if (/WebGL/i.test(message.text())) webglWarnings.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
const steps = [];
const findings = {};
const screenshots = [];

async function step(name, action) {
  await action();
  steps.push(name);
}
async function screenshot(name) {
  await page.screenshot({ path: NodePath.resolve(output, name) });
  screenshots.push(name);
}
async function violations() {
  return page.evaluate(() => [...window.__fixtureViolations]);
}
async function settled() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function canvasReady(mode) {
  await page
    .locator(`.workjet-slide-canvas[data-mode="${mode}"][data-canvas-ready="true"]`)
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settled();
}
async function slideTitle(text) {
  await page.getByText(new RegExp(`slide \\d of 3 · ${text}`)).waitFor();
}
async function button(name) {
  await page.getByRole("button", { name, exact: true }).click();
}
/** Scene coordinates to page coordinates for the edit viewport (whole frame fitted, centred). */
async function editPoint(sceneX, sceneY) {
  const box = await page.locator(".workjet-slide-canvas__host").boundingBox();
  NodeAssert.ok(box, "edit host has no box");
  const zoom = Math.min(box.width / FRAME.width, box.height / FRAME.height) * EDIT_FIT_MARGIN;
  return {
    zoom,
    x: box.x + (box.width - FRAME.width * zoom) / 2 + sceneX * zoom,
    y: box.y + (box.height - FRAME.height * zoom) / 2 + sceneY * zoom,
  };
}
/** RGB of the presented static drawing at a scene point (present mode: frame = stage). */
async function presentedPixel(sceneX, sceneY) {
  return page.evaluate(
    ({ sceneX, sceneY, frame }) => {
      const canvas = document.querySelector(
        ".workjet-slide-canvas canvas.excalidraw__canvas.static",
      );
      const stage = document.querySelector(".workjet-slide-canvas__stage");
      if (!(canvas instanceof HTMLCanvasElement) || !stage) return null;
      const stageBox = stage.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      const zoom = stageBox.width / frame.width;
      const x = stageBox.left + sceneX * zoom - canvasBox.left;
      const y = stageBox.top + sceneY * zoom - canvasBox.top;
      const scale = canvas.width / canvasBox.width;
      const data = canvas
        .getContext("2d")
        .getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [data[0], data[1], data[2]];
    },
    { sceneX, sceneY, frame: FRAME },
  );
}

let editZoom = 0;
try {
  await step("open fixture under the renderer CSP", async () => {
    await page.goto(FIXTURE_URL);
    NodeAssert.equal(
      await page.locator('meta[http-equiv="Content-Security-Policy"]').count(),
      1,
      "CSP meta missing",
    );
    await canvasReady("present");
    await slideTitle("Jour fixe · Projekt Nordlicht");
  });
  await step("present slide 1 (migrated, no stored canvas)", async () => {
    await page.waitForFunction(() => document.fonts.check('16px "Virgil"'));
    await screenshot("slide-1-present.png");
  });
  await step("present slide 2 with handwriting and a live three.js embed", async () => {
    await button("Next slide");
    await slideTitle("Was wir aus dem Modell lernen");
    await canvasReady("present");
    await page.waitForFunction(() =>
      [...document.fonts].some(
        (face) => face.family.replace(/["']/g, "") === "Virgil" && face.status === "loaded",
      ),
    );
    findings.fonts = await page.evaluate(() => ({
      excalifont: document.fonts.check('16px "Excalifont"'),
      virgil: document.fonts.check('16px "Virgil"'),
      loadedFaces: [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => face.family.replace(/["']/g, ""))
        .filter((family, index, all) => all.indexOf(family) === index),
    }));
    NodeAssert.ok(findings.fonts.virgil, "Virgil not loaded");
    const scene = page.locator('[data-canvas-embed-id="ideen:law"] figure[data-scene-mode="live"]');
    await scene.waitFor({ timeout: 20_000 });
    await settled();
    findings.webgl = await page.evaluate(() => {
      const canvas = document.querySelector(
        '[data-canvas-embed-id="ideen:law"] .lb-scene3d-port canvas',
      );
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      return gl
        ? { context: gl.constructor.name, width: canvas.width, height: canvas.height }
        : null;
    });
    NodeAssert.ok(findings.webgl, "no WebGL canvas inside the modell.law embed");
    await settled();
    await screenshot("slide-2-present.png");
  });
  await step("present slide 3 with business.kpi-bars data", async () => {
    await button("Next slide");
    await slideTitle("Kennzahlen seit dem letzten Termin");
    await canvasReady("present");
    await page.locator('[data-canvas-embed-id="kennzahlen:kpi"] figure.lb-scene3d').waitFor();
    findings.kpiEmbed = await page
      .locator('[data-canvas-embed-id="kennzahlen:kpi"] figure.lb-scene3d')
      .getAttribute("data-scene-mode");
    await settled();
    await screenshot("slide-3-present.png");
    await button("Previous slide");
    await slideTitle("Was wir aus dem Modell lernen");
    await canvasReady("present");
  });
  await step("edit: add handwritten text", async () => {
    await button("Edit");
    await canvasReady("edit");
    // The radio input sits under its icon; click the tool label like a user.
    await page.locator('label:has(> [data-testid="toolbar-text"])').click();
    const point = await editPoint(300, 700);
    editZoom = point.zoom;
    await page.mouse.click(point.x, point.y);
    const editor = page.locator("textarea.excalidraw-wysiwyg");
    await editor.waitFor();
    await page.keyboard.type(NEW_TEXT);
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
  });
  await step(`edit: drag the rectangle by ${DRAG_PX} px`, async () => {
    const start = await editPoint(
      RECTANGLE.x + RECTANGLE.width / 2,
      RECTANGLE.y + RECTANGLE.height / 2,
    );
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + DRAG_PX / 2, start.y, { steps: 6 });
    await page.mouse.move(start.x + DRAG_PX, start.y, { steps: 6 });
    await page.mouse.up();
    await page.locator('[data-save-status="dirty"]').waitFor();
    await settled();
    await screenshot("slide-2-edit.png");
  });
  await step("save validates and stores the scene", async () => {
    await button("Save");
    await page.locator('[data-save-status="saved"]').waitFor();
    await screenshot("slide-2-after-save.png");
  });
  await step("switch slide away and back", async () => {
    await button("Next slide");
    await slideTitle("Kennzahlen seit dem letzten Termin");
    await canvasReady("edit");
    await button("Previous slide");
    await slideTitle("Was wir aus dem Modell lernen");
    await canvasReady("edit");
  });
  await step("saved scene keeps the new text and the moved rectangle", async () => {
    const saved = await page.evaluate(() => window.slideEngineFixture.savedSlide("ideen"));
    const elements = saved.canvas.elements;
    const text = elements.find((item) => item.type === "text" && item.text === "Neuer Gedanke");
    NodeAssert.ok(text, "new text missing from the saved scene");
    NodeAssert.equal(
      text.fontFamily,
      1,
      "new text is not in the handwriting font (Virgil, family 1)",
    );
    NodeAssert.equal(
      elements.find((item) => item.id === "ideen:note")?.fontFamily,
      1,
      "fixture handwriting changed family",
    );
    const rectangle = elements.find((item) => item.id === RECTANGLE.id);
    const expectedX = RECTANGLE.x + DRAG_PX / editZoom;
    findings.savedRectangle = { x: rectangle?.x, expectedX, y: rectangle?.y };
    NodeAssert.ok(
      rectangle && Math.abs(rectangle.x - expectedX) < 4 && Math.abs(rectangle.y - RECTANGLE.y) < 4,
      `rectangle not moved: ${JSON.stringify(findings.savedRectangle)}`,
    );
  });
  await step("presented slide shows the saved edits", async () => {
    await button("Present");
    await canvasReady("present");
    await page
      .locator(".workjet-slide-canvas__transcript p", { hasText: NEW_TEXT })
      .waitFor({ state: "attached" });
    const { x } = findings.savedRectangle;
    const movedCenter = await presentedPixel(
      x + RECTANGLE.width / 2,
      RECTANGLE.y + RECTANGLE.height / 2,
    );
    const vacated = await presentedPixel(RECTANGLE.x + 40, RECTANGLE.y + RECTANGLE.height / 2);
    findings.pixels = { movedCenter, vacated };
    // #fff3bf fill at the new place; paper (#fffef8) where the rectangle was.
    NodeAssert.ok(movedCenter && movedCenter[2] < 215, `moved rectangle not drawn: ${movedCenter}`);
    NodeAssert.ok(vacated && vacated[2] > 235, `old rectangle still drawn: ${vacated}`);
    await screenshot("slide-2-present-after-save.png");
  });
  await step("present: drawing does not pan or zoom, the 3D embed stays interactive", async () => {
    const stage = await page.locator(".workjet-slide-canvas__stage").boundingBox();
    NodeAssert.ok(stage, "stage has no box");
    const empty = { x: stage.x + stage.width * 0.1, y: stage.y + stage.height * 0.85 };
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.wheel(0, 600);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await page.mouse.down();
    await page.mouse.move(empty.x + 200, empty.y - 150, { steps: 8 });
    await page.mouse.up();
    await settled();
    const { x } = findings.savedRectangle;
    const movedCenter = await presentedPixel(
      x + RECTANGLE.width / 2,
      RECTANGLE.y + RECTANGLE.height / 2,
    );
    NodeAssert.deepEqual(movedCenter, findings.pixels.movedCenter, "presented drawing moved");
    const slider = page.locator('[data-canvas-embed-id="ideen:law"] input[type="range"]');
    const before = await slider.inputValue();
    const box = await slider.boundingBox();
    NodeAssert.ok(box, "scene slider has no box");
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    const after = await slider.inputValue();
    findings.sceneSlider = { before, after };
    NodeAssert.notEqual(after, before, "3D scene slider did not react in present mode");
  });
  await step("mode and slide switches leave one editor and one WebGL scene", async () => {
    for (let round = 0; round < 3; round++) {
      await button("Edit");
      await canvasReady("edit");
      await button("Present");
      await canvasReady("present");
      await button("Next slide");
      await canvasReady("present");
      await button("Previous slide");
      await canvasReady("present");
    }
    await page
      .locator('[data-canvas-embed-id="ideen:law"] figure[data-scene-mode="live"]')
      .waitFor();
    findings.afterSwitching = await page.evaluate(() => ({
      editors: document.querySelectorAll(".excalidraw").length,
      embedHosts: document.querySelectorAll(".learnordie-canvas-embed-host").length,
      sceneCanvases: document.querySelectorAll(".lb-scene3d-port canvas").length,
      stylesheets: document.querySelectorAll("#workjet-excalidraw-css").length,
      canvasStyles: document.querySelectorAll("#workjet-slide-canvas-css").length,
    }));
    NodeAssert.deepEqual(findings.afterSwitching, {
      editors: 1,
      embedHosts: 1,
      sceneCanvases: 1,
      stylesheets: 1,
      canvasStyles: 1,
    });
    NodeAssert.deepEqual(webglWarnings, [], "WebGL context warnings");
  });
  await step("dark theme", async () => {
    await button("Dark");
    await page
      .locator('.workjet-slide-canvas[data-theme="dark"] .excalidraw.theme--dark')
      .waitFor();
    await settled();
    await screenshot("slide-2-present-dark.png");
    await button("Light");
  });
  findings.cspViolations = await violations();
  findings.consoleErrors = [...consoleErrors];
  NodeAssert.deepEqual(findings.cspViolations, [], "CSP violations");
  NodeAssert.deepEqual(findings.consoleErrors, [], "console errors");

  // Diagnostics after the gate: SVG export (font subsetting) and a CSP positive control.
  const before = { errors: consoleErrors.length, violations: findings.cspViolations.length };
  findings.exportDiagnostic = await page.evaluate(async () => {
    try {
      return { ok: true, svgLength: await window.slideEngineFixture.exportCurrentSlideSvg() };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  await settled();
  findings.exportDiagnostic.consoleErrors = consoleErrors.slice(before.errors);
  findings.exportDiagnostic.cspViolations = (await violations()).slice(before.violations);
  // Positive control: the meta policy is enforced (a data: script is refused).
  findings.cspPositiveControl = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const script = document.createElement("script");
        const refused = (event) => {
          if (event.blockedURI.startsWith("data"))
            resolve(`refused by ${event.effectiveDirective}`);
        };
        document.addEventListener("securitypolicyviolation", refused, { once: true });
        script.src = "data:text/javascript,window.__fixtureDataScript=true";
        script.addEventListener("load", () => resolve("data script executed"));
        document.head.append(script);
      }),
  );
  await NodeFSP.writeFile(
    NodePath.resolve(output, "result.json"),
    JSON.stringify(
      {
        status: "debug-passed",
        installedAcceptance: false,
        source: "fixture only",
        steps,
        screenshots,
        findings,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ status: "debug-passed", steps: steps.length, screenshots, findings }, null, 2),
  );
} catch (error) {
  await screenshot("slide-engine-fixture-finding.png").catch(() => {});
  findings.cspViolations = await violations().catch(() => ["unavailable"]);
  await NodeFSP.writeFile(
    NodePath.resolve(output, "result.json"),
    JSON.stringify(
      { status: "failed", steps, screenshots, findings, consoleErrors, failure: String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
