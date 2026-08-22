import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionHubPlugin } from "../src/plugin.mjs";
import { OS_EVENT } from "../src/nav.mjs";
import { createSource } from "../src/source.mjs";
import { CONTENT_LINES } from "../src/layout.mjs";

// Der komplette Bedienweg gegen den echten Demo-Datensatz. Bildvergleiche
// zeigen nur, DASS sich etwas aendert — hier wird geprueft, ob sich das
// RICHTIGE aendert.

function harness() {
  const calls = { create: 0, rebuild: 0, image: 0, lastPage: null };
  const sdk = {
    async createStartUpPageContainer(page) { calls.create += 1; calls.lastPage = page; return 0; },
    async rebuildPageContainer(page) { calls.rebuild += 1; calls.lastPage = page; return true; },
    async textContainerUpgrade() { return true; },
    async updateImageRawData() { calls.image += 1; return "success"; },
  };
  const answers = [];
  const source = createSource();
  const original = source.answer.bind(source);
  source.answer = async (payload) => { answers.push(payload); return original(payload); };
  return { sdk, calls, answers, source };
}

const body = (calls) =>
  calls.lastPage.textObject.find((c) => c.containerName === "box-body").content;

test("scrolling down walks through every page of the case", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  const seen = [body(calls)];
  for (let i = 0; i < 4; i += 1) {
    await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
    seen.push(body(calls));
  }
  assert.equal(new Set(seen).size, 5, "five distinct pages: mail, reply, task, notes, audit");
  assert.ok(seen[0].includes("MAIL"));
  assert.ok(seen[1].includes("ANTWORT"));
  assert.ok(seen[2].includes("AUFGABE"));
});

test("scrolling up returns to the previous page", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  const first = body(calls);
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  const second = body(calls);
  assert.notEqual(first, second);
  await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(body(calls), first, "scrolling up must land on the page we came from");
});

test("a press opens the long version and scrolling pages through it", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  const kurz = body(calls);
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "detail");
  const langSeite1 = body(calls);
  assert.notEqual(kurz, langSeite1, "the long version must differ from the short one");
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.equal(plugin.state.page, 1, "inside the long version a scroll is a page turn");
  assert.notEqual(body(calls), langSeite1);
});

test("the end of the long version continues into the next page", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);          // MAIL lang
  for (let i = 0; i < 6; i += 1) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.equal(plugin.state.level, "rubrik", "back to the short form …");
  assert.ok(plugin.state.sectionIndex >= 1, "… on a later page, not on the same one");
});

test("a double press collapses the long version again", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "detail");
  await plugin.handleEvent(OS_EVENT.DOUBLE_CLICK);
  assert.equal(plugin.state.level, "rubrik");
});

test("past the last page the focus reaches every action icon, then the next case", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  const start = plugin.state.index;
  const focusSeen = new Set();
  for (let i = 0; i < 40 && plugin.state.index === start; i += 1) {
    await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
    if (plugin.state.focusIcon >= 0) focusSeen.add(plugin.state.focusIcon);
  }
  assert.equal(focusSeen.size, 4, "annehmen, ablehnen, korrektur, später");
  assert.notEqual(plugin.state.index, start, "after the icons the next case begins");
  assert.equal(plugin.state.focusIcon, -1, "a fresh case starts on its first page");
});

test("a press on an icon answers, a press on a page never does", async () => {
  const { sdk, answers, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(answers.length, 0, "pressing a page expands, it must not decide");
  await plugin.handleEvent(OS_EVENT.DOUBLE_CLICK);
  while (plugin.state.focusIcon < 0) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(answers.length, 1, "exactly one answer per press");
  assert.equal(answers[0].wert, "annehmen");
});

test("no page ever overflows its container", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  for (let i = 0; i < 25; i += 1) {
    const lines = body(calls).split("\n").length;
    assert.ok(lines <= CONTENT_LINES + 2, `page renders ${lines} lines, budget is ${CONTENT_LINES} + title + rule`);
    await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  }
});

test("head tilt hides and shows the display", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, tiltOptions: { threshold: 25 } });
  await plugin.start();
  await plugin.handleImu({ x: 0, y: 0, z: 0 });
  await plugin.handleImu({ x: 0, y: -40, z: 0 });
  assert.equal(plugin.visible, false);
  assert.equal(calls.lastPage.textObject.length, 1, "hidden means a blank page");
  await plugin.handleImu({ x: 0, y: 40, z: 0 });
  assert.equal(plugin.visible, true);
  assert.ok(calls.lastPage.textObject.length > 1, "and the content comes back");
});

test("scrolling up past the first page reaches the previous case", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  // erst zum zweiten Vorgang, dann wieder hoch
  const start = plugin.state.index;
  while (plugin.state.index === start) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  const second = plugin.state.index;
  while (plugin.state.index === second) await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(plugin.state.index, start, "up must lead back to the case we came from");
});

test("a second press collapses the long version again", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "detail");
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "rubrik", "press must toggle, not only open");
});

test("from the icons a scroll up returns into the pages", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source });
  await plugin.start();
  while (plugin.state.focusIcon < 0) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  while (plugin.state.focusIcon > 0) await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(plugin.state.focusIcon, -1, "back in the text …");
  assert.ok(plugin.state.sectionIndex >= 0, "… on a page of the same case");
});
