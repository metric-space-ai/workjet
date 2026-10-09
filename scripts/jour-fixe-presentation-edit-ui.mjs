#!/usr/bin/env node
// Real room/editor regression on the isolated loopback fixture; no native or customer access.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const [modulePath, outputDirectory] = process.argv.slice(2);
if (!modulePath || !outputDirectory) throw new Error("PLAYWRIGHT_MODULE and OUTPUT_DIRECTORY required");
const { chromium } = NodeModule.createRequire(import.meta.url)(NodePath.resolve(modulePath));
const output = NodePath.resolve(outputDirectory);
await NodeFSP.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  args: ["--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const discarded = "Discard this unsaved canvas idea";
const steps = [];
async function ready(mode) {
  await page.locator(`.workjet-slide-canvas[data-mode="${mode}"][data-canvas-ready="true"]`).waitFor();
  await page.evaluate(() => document.fonts.ready);
}
try {
  await page.goto("http://127.0.0.1:5767/jour-fixe-fixture.html?presentation=1");
  await page.getByRole("button", { name: "Open meeting", exact: true }).click();
  await ready("present");
  await page.getByRole("button", { name: "Edit slide", exact: true }).click();
  await ready("edit");
  await page.locator('label:has(> [data-testid="toolbar-text"])').click();
  const host = await page.locator(".workjet-slide-canvas__host").boundingBox();
  NodeAssert.ok(host);
  const zoom = Math.min(host.width / 1600, host.height / 900) * 0.92;
  await page.mouse.click(host.x + (host.width - 1600 * zoom) / 2 + 300 * zoom,
    host.y + (host.height - 900 * zoom) / 2 + 700 * zoom);
  await page.locator("textarea.excalidraw-wysiwyg").waitFor();
  await page.keyboard.type(discarded);
  await page.keyboard.press("Escape");
  // Cancel immediately, including a change that may still be waiting for the debounce.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await ready("present");
  NodeAssert.equal(await page.locator(".workjet-slide-canvas__transcript").getByText(discarded, { exact: true }).count(), 0,
    "Cancel retained the unsaved editor scene");
  NodeAssert.equal(await page.getByLabel("Fixture canvas save count").textContent(), "0");
  steps.push("edit text then Cancel restores authoritative scene without a save");
  await page.screenshot({ path: NodePath.join(output, "cancel-restored.png") });
  await page.getByRole("button", { name: "Edit slide", exact: true }).click();
  await ready("edit");
  await page.getByRole("button", { name: "Save slide", exact: true }).click();
  await ready("present");
  NodeAssert.equal(await page.getByLabel("Fixture canvas save count").textContent(), "0",
    "Old cleanup re-emitted the discarded edit and caused a save on re-entry");
  NodeAssert.equal(await page.locator(".workjet-slide-canvas__transcript").getByText(discarded, { exact: true }).count(), 0);
  steps.push("re-enter then Save has no discarded draft or extra write");
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(NodePath.join(output, "result.json"), JSON.stringify({ pass: true,
    installedAcceptance: false, scope: "isolated real room/canvas fixture", steps, errors }, null, 2));
  console.log(JSON.stringify({ pass: true, steps, errors }));
} catch (error) {
  await page.screenshot({ path: NodePath.join(output, "failure.png") });
  await NodeFSP.writeFile(NodePath.join(output, "result.json"), JSON.stringify({ pass: false,
    installedAcceptance: false, steps, errors, failure: String(error) }, null, 2));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
