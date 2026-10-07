#!/usr/bin/env node
// Non-critical fixture debugging. This does not replace installed native/speech acceptance.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const [modulePath, outputDirectory] = process.argv.slice(2);
if (!modulePath || !outputDirectory) throw new Error("Usage: node scripts/jour-fixe-fixture-ui.mjs PLAYWRIGHT_MODULE OUTPUT_DIRECTORY");
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ["--use-mock-keychain", "--password-store=basic"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: output } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const steps = [];
async function step(name, action) { await action(); steps.push(name); }
async function screenshot(name) { await page.screenshot({ path: resolve(output, name), fullPage: true }); }
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Horizontal overflow"); }
try {
  await step("overview entry", async () => { await page.goto("http://127.0.0.1:5745/jour-fixe-fixture.html"); await page.getByRole("button", { name: "Open meeting", exact: true }).click(); await page.locator('[data-meeting-state="live"]').waitFor(); });
  await step("narration playback", async () => { await page.getByRole("button", { name: "Play narration", exact: true }).click(); await page.getByRole("button", { name: "Pause narration", exact: true }).waitFor(); await page.getByRole("button", { name: "Pause narration", exact: true }).click(); await page.getByRole("combobox", { name: "Playback speed" }).selectOption("1.5"); });
  await step("slide navigation", async () => { await page.getByRole("button", { name: "Next slide", exact: true }).click(); await page.getByRole("heading", { name: "Open decisions", exact: true }).waitFor(); await page.getByRole("button", { name: "Previous slide", exact: true }).click(); });
  await step("normalized pinned comment", async () => { const stage = page.getByRole("button", { name: "Place a comment on the slide", exact: true }); const box = await stage.boundingBox(); assert.ok(box); await stage.click({ position: { x: box.width * .72, y: box.height * .58 } }); await page.getByRole("textbox", { name: "Comment to supervisor" }).fill("Fixture decision: preserve restart state."); await screenshot("Jour-fixe-fixture-live-1440.png"); await page.getByRole("button", { name: "To supervisor", exact: true }).click(); await page.getByRole("button", { name: "Comment 2: Fixture decision: preserve restart state.", exact: true }).waitFor(); });
  await step("failed receipt preserves draft", async () => { await page.getByRole("button", { name: "Fail next receipt", exact: true }).click(); await page.getByRole("button", { name: "Place a comment on the slide", exact: true }).press("Enter"); await page.getByRole("textbox", { name: "Comment to supervisor" }).fill("Preserve this draft after failure."); await page.getByRole("button", { name: "To supervisor", exact: true }).click(); await page.getByRole("alert").waitFor(); assert.equal(await page.getByRole("textbox", { name: "Comment to supervisor" }).inputValue(), "Preserve this draft after failure."); await page.getByRole("button", { name: "To supervisor", exact: true }).click(); await page.getByRole("button", { name: "Comment 3: Preserve this draft after failure.", exact: true }).waitFor(); });
  await step("partial transcript", async () => { await page.getByRole("button", { name: "Start microphone", exact: true }).click(); const partial = page.getByText("Fixture partial transcript…", { exact: true }); await partial.waitFor(); assert.equal(await partial.evaluate((element) => getComputedStyle(element).fontStyle), "italic"); await page.getByRole("button", { name: "Stop microphone", exact: true }).click(); });
  await step("message receipt", async () => { await page.getByRole("textbox", { name: "Message to supervisor", exact: true }).fill("Fixture owner acceptance."); await page.getByRole("button", { name: "Send message", exact: true }).click(); await page.getByText("Fixture owner acceptance.", { exact: true }).waitFor(); });
  await step("review proposal and confirmation", async () => { await page.getByRole("button", { name: "End meeting", exact: true }).click(); await page.locator('[data-meeting-state="review"]').waitFor(); await page.getByRole("textbox", { name: "Todo 1 title", exact: true }).fill("Verify restart persistence"); await page.getByRole("textbox", { name: "Acceptance", exact: true }).fill("Saved state survives a complete Quit/Reopen."); await page.getByRole("button", { name: "Save edits", exact: true }).click(); await page.getByRole("button", { name: "Confirm 1 to-dos", exact: true }).waitFor({ state: "visible" }); await screenshot("Jour-fixe-fixture-review-1440.png"); await page.getByRole("button", { name: "Confirm 1 to-dos", exact: true }).click(); await page.locator('[data-meeting-state="confirmed"]').waitFor(); await page.getByRole("heading", { name: "Confirmed to-dos", exact: true }).waitFor(); });
  await step("calendar entry", async () => { await page.getByRole("button", { name: "Calendar", exact: true }).click(); await page.getByRole("button", { name: "Open meeting for Fixture project", exact: true }).click(); await page.locator('[data-workjet-jour-fixe-room]').waitFor(); });
  for (const width of [1000, 390]) await step(`responsive ${width}`, async () => { await page.setViewportSize({ width, height: 1000 }); await page.reload(); await page.getByRole("button", { name: "Open meeting", exact: true }).click(); await noOverflow(); await screenshot(`Jour-fixe-fixture-live-${width}.png`); });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "result.json"), JSON.stringify({ status: "debug-passed", installedAcceptance: false, independentReview: "not-run", source: "fixture only", steps, errors }, null, 2));
} catch (error) {
  await screenshot("Jour-fixe-fixture-finding.png");
  await writeFile(resolve(output, "result.json"), JSON.stringify({ status: "failed", installedAcceptance: false, steps, errors, failure: String(error) }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); }
