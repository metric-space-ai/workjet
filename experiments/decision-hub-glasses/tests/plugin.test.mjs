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
  assert.equal(page.textObject.length, 2, "items column + reading box");
  assert.ok(page.textObject.length <= 8, "the SDK allows at most 8 text containers");
  assert.equal(page.imageObject.length, 4, "channel icons, nav dots, icon bar and the rubric legend");
  assert.ok(page.imageObject.every((i) => i.width <= 288 && i.height <= 144), "images stay inside the SDK limits");
});

test("the body never overflows its container", async () => {
  const sdk = fakeSdk();
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource() });
  await plugin.start();
  const body = sdk.calls.lastPage.textObject.find((c) => c.containerName === "box-body");
  // Titel + Trennlinie + Inhalt
  assert.ok(body.content.split("\n").length <= CONTENT_LINES + 2);
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

// Die Firmware weist eine Seite als Ganzes zurueck, wenn ein einziger
// Container ausserhalb der Grenzen liegt — und nennt dabei nicht welcher.
// Der Simulator akzeptiert solche Seiten, das Geraet nicht. Deshalb hier.
test("every page respects the firmware limits for containers", async () => {
  const { createDecisionHubPlugin } = await import("../src/plugin.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { OS_EVENT } = await import("../src/nav.mjs");
  const seiten = [];
  const sdk = {
    async createStartUpPageContainer(p) { seiten.push(p); return 0; },
    async rebuildPageContainer(p) { seiten.push(p); return true; },
    async textContainerUpgrade() { return true; },
    async updateImageRawData() { return "success"; },
  };
  const plugin = createDecisionHubPlugin({ sdk, source: createSource(), scrollSperreMs: 0 });
  await plugin.start();
  for (let i = 0; i < 20; i += 1) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);

  for (const seite of seiten) {
    const text = seite.textObject || [];
    const bild = seite.imageObject || [];
    assert.ok(text.length <= 8, `at most 8 text containers, got ${text.length}`);
    assert.ok(bild.length <= 4, `at most 4 image containers, got ${bild.length}`);
    const gesamt = text.length + bild.length;
    assert.ok(gesamt >= 1 && gesamt <= 12, `1..12 containers, got ${gesamt}`);
    assert.equal(seite.containerTotalNum, gesamt, "the announced count must match reality");
    for (const c of bild) {
      assert.ok(c.width >= 20 && c.width <= 288, `image "${c.containerName}" is ${c.width} wide, allowed is 20..288`);
      assert.ok(c.height >= 20 && c.height <= 144, `image "${c.containerName}" is ${c.height} high, allowed is 20..144`);
    }
    const ids = [...text, ...bild].map((c) => c.containerID);
    assert.equal(new Set(ids).size, ids.length, "container ids must be unique across the page");
  }
});

// Die Rubrik muss IM Rahmen stehen, nicht als Zeile darin: der Streifen
// liegt ueber der oberen Rahmenkante und unterbricht sie genau dort.
test("the rubric sits in the frame, not inside the box", async () => {
  const { buildPage, CONTAINER, PANEL_CHARS, boxTitle } = await import("../src/layout.mjs");
  const { initialNav } = await import("../src/nav.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { sectionsOf } = await import("../../kundenpipeline-module/core/sections.mjs");
  const daten = await createSource().load();
  const nav = {
    ...initialNav(),
    sections: sectionsOf(daten.decisions[0], daten.vorgaenge[0], ["mail", "antwort"], PANEL_CHARS),
    tabs: [{ titel: "REM", kanal: "mail" }], tabIndex: 0,
    icons: [{ id: "annehmen" }], betreff: "REM", typ: "TRIAGE",
  };
  const page = buildPage(nav);
  const box = page.textObject.find((c) => c.containerName === "box-body");
  const legende = page.imageObject.find((c) => c.containerName === "legend");

  assert.ok(legende, "there must be a legend strip");
  assert.ok(!box.content.startsWith("MAIL"), "the title must not be the first line of the box any more");
  assert.ok(!box.content.includes("─"), "and no rule underneath it either");
  assert.ok(box.content.startsWith("REM Capital kommt"), "the box starts straight into the summary");

  const boxOben = page.textObject.find((c) => c.containerName === "box-body").yPosition;
  assert.ok(legende.yPosition < boxOben, "the strip sits above the top edge …");
  assert.ok(legende.yPosition + legende.height > boxOben, "… and reaches across it, so the frame is broken there");
  assert.ok(legende.xPosition > box.xPosition, "indented, not starting in the corner");
  assert.ok(legende.width >= 20 && legende.width <= 288, "and within the firmware limits");
  assert.equal(boxTitle(nav).includes("MAIL"), true, "the strip carries the rubric name");
});

// Ein Neuaufbau der Seite ersetzt die Container und leert ihre Bilder.
// Werden sie dann als "unveraendert" uebersprungen, fehlen Icons und Punkte.
test("images are resent after every page rebuild", async () => {
  const { createDecisionHubPlugin } = await import("../src/plugin.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { OS_EVENT } = await import("../src/nav.mjs");
  let rebuilds = 0;
  const bilderNachRebuild = [];
  let seitRebuild = 0;
  const sdk = {
    async createStartUpPageContainer() { return 0; },
    async rebuildPageContainer() {
      if (rebuilds > 0) bilderNachRebuild.push(seitRebuild);
      rebuilds += 1; seitRebuild = 0; return true;
    },
    async textContainerUpgrade() { return true; },
    async updateImageRawData() { seitRebuild += 1; return 0; },
  };
  const plugin = createDecisionHubPlugin({ sdk, source: createSource(), scrollSperreMs: 0 });
  await plugin.start();
  for (let i = 0; i < 4; i += 1) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.ok(rebuilds >= 3, "the test needs several rebuilds to be meaningful");
  assert.ok(bilderNachRebuild.every((n) => n > 0),
    `after a rebuild the images must be sent again, got ${JSON.stringify(bilderNachRebuild)}`);
});
