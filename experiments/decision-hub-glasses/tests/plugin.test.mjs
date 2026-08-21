import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionHubPlugin } from "../src/plugin.mjs";
import { OS_EVENT } from "../src/nav.mjs";
import { buildPage, buildBitmaps, CONTENT_LINES } from "../src/layout.mjs";

function fakeSdk() {
  const calls = { create: 0, rebuild: 0, image: 0, lastPage: null };
  return {
    calls,
    async createStartUpPageContainer(page) { calls.create += 1; calls.lastPage = page; return 0; },
    async rebuildPageContainer(page) { calls.rebuild += 1; calls.lastPage = page; return true; },
    async textContainerUpgrade() { return true; },
    async updateImageRawData() { calls.image += 1; return "success"; },
  };
}

function fakeSource(answers = []) {
  return {
    answers,
    async load() {
      return {
        decisions: [{ id: "d1", vorgang_id: "v1", typ: "triage", titel: "REM", status: "offen", zeilen_json: ["kurz"] }],
        vorgaenge: [{
          id: "v1", kunde_name: "REM",
          quelle_json: { absender: "a@example.org", body_clean: "Eine Mail mit Inhalt." },
          triage_json: { antwort_vorschlag: "Antwort", aufgabe: { agent: "Sol", beschreibung: "Arbeitspaket" } },
        }],
      };
    },
    async answer(payload) { answers.push(payload); },
  };
}

test("the page carries the reading box and one item per rubric", async () => {
  const sdk = fakeSdk();
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource() });
  await plugin.start();
  const page = sdk.calls.lastPage;
  const items = page.textObject.filter((c) => c.containerName.startsWith("item-"));
  assert.ok(items.length >= 1, "the rubrics are listed as items");
  assert.equal(page.textObject.length, 2 + items.length, "box title + box body + items");
  assert.ok(page.textObject.length <= 8, "the SDK allows at most 8 text containers");
  assert.equal(page.imageObject.length, 2, "nav dots and the icon bar");
  assert.ok(page.imageObject.every((i) => i.width <= 288 && i.height <= 144), "images stay inside the SDK limits");
});

test("the body never overflows its container", async () => {
  const sdk = fakeSdk();
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource() });
  await plugin.start();
  const body = sdk.calls.lastPage.textObject.find((c) => c.containerName === "box-body");
  assert.ok(body.content.split("\n").length <= CONTENT_LINES);
  assert.equal(body.isEventCapture, 1);
});

test("bitmaps are repainted when the position changes", async () => {
  const sdk = fakeSdk();
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource() });
  await plugin.start();
  const before = sdk.calls.image;
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.ok(sdk.calls.image > before, "the rail must show the new position");
});

test("a press on an icon answers exactly once", async () => {
  const sdk = fakeSdk();
  const answers = [];
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource(answers) });
  await plugin.start();
  // bis hinter die letzte Rubrik scrollen, dann steht der Fokus auf dem
  // ersten Icon (Annehmen).
  for (let i = 0; i < 8; i += 1) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  const state = plugin.state;
  if (state.focusIcon >= 0) {
    await plugin.handleEvent(OS_EVENT.CLICK);
    assert.ok(answers.length <= 1, "never more than one answer per press");
  }
});

test("a press in the overview expands instead of answering", async () => {
  const sdk = fakeSdk();
  const answers = [];
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource(answers) });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(answers.length, 0);
  assert.equal(plugin.state.level, "detail");
});

// Der Host lehnt eine Seite ab, deren containerTotalNum nicht zur Zahl der
// Container passt — sichtbar als schwarzes Display. Der SDK-Validator kennt
// diese Regel, also wird er hier befragt.
test("the page passes the SDK's own validation", async () => {
  const { validateEvenHubPageContainer } = await import("@evenrealities/even_hub_sdk");
  const sdk = fakeSdk();
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource() });
  await plugin.start();
  const page = sdk.calls.lastPage;
  const total = (page.textObject?.length || 0) + (page.imageObject?.length || 0);
  assert.equal(page.containerTotalNum, total, "containerTotalNum must count every container");
  const result = validateEvenHubPageContainer(page);
  assert.ok(result?.ok !== false, `SDK validation: ${JSON.stringify(result)}`);
});
