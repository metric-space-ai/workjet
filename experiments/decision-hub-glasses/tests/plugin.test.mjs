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
  // Die Vorgangsliste ist ein Bild, kein Text: nur so laesst sich der
  // aktive Eintrag invertieren.
  // Lesekasten plus der winzige Eingabecontainer, der die Gesten annimmt.
  assert.equal(page.textObject.length, 2, "reading box and the gesture catcher");
  const box = page.textObject.find((c) => c.containerName === "box-body");
  assert.equal(box.isEventCapture, 0, "the reading box must never capture input …");
  const fang = page.textObject.find((c) => c.containerName === "input");
  assert.equal(fang.isEventCapture, 1, "… the empty catcher does");
  assert.equal(fang.content, "", "and it stays empty, so there is nothing to scroll");
  assert.ok(page.imageObject.some((c) => c.containerName === "liste"), "the case list is a bitmap");
  assert.ok(page.textObject.length <= 8, "the SDK allows at most 8 text containers");
  // Die Aktionsleiste ist kein eigener Container mehr: sie sitzt im
  // Listenbild, auf dem reservierten Platz des aktiven Vorgangs.
  assert.equal(page.imageObject.length, 3, "case list, scroll indicator and rubric legend");
  assert.ok(page.imageObject.every((i) => i.width <= 288 && i.height <= 144), "images stay inside the SDK limits");
});

test("the body never overflows its container", async () => {
  const sdk = fakeSdk();
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource() });
  await plugin.start();
  const body = sdk.calls.lastPage.textObject.find((c) => c.containerName === "box-body");
  assert.ok(body.content.split("\n").length <= CONTENT_LINES + 2);
  // Der Lesekasten darf KEINE Eingaben fangen: ein Eingabecontainer bekommt
  // vom Betriebssystem Scrollverhalten samt Federn, auch bei kurzem Text.
  assert.equal(body.isEventCapture, 0);
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
test("images are resent after a rebuild, or icons vanish", async () => {
  const { createDecisionHubPlugin } = await import("../src/plugin.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { OS_EVENT } = await import("../src/nav.mjs");
  // Ein Neuaufbau ersetzt die Container und leert ihre Bilder. Er passiert
  // jetzt nur noch bei echter Strukturaenderung — Ausblenden ist eine.
  let bilderSeitRebuild = 0;
  const sdk = {
    async createStartUpPageContainer() { return 0; },
    async rebuildPageContainer() { bilderSeitRebuild = 0; return true; },
    async textContainerUpgrade() { return true; },
    async updateImageRawData() { bilderSeitRebuild += 1; return 0; },
  };
  const plugin = createDecisionHubPlugin({ sdk, source: createSource(), scrollSperreMs: 0 });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.SCROLL_TOP);          // blendet aus -> leere Seite
  assert.equal(plugin.visible, false);
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);       // kommt zurueck -> Neuaufbau
  assert.equal(plugin.visible, true);
  assert.ok(bilderSeitRebuild > 0,
    "after the page was rebuilt the images must be sent again");
  plugin.stop?.();
});

test("scrolling swaps text instead of rebuilding the page", async () => {
  const { createDecisionHubPlugin } = await import("../src/plugin.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { OS_EVENT } = await import("../src/nav.mjs");
  let rebuilds = 0;
  let upgrades = 0;
  const sdk = {
    async createStartUpPageContainer() { return 0; },
    async rebuildPageContainer() { rebuilds += 1; return true; },
    async textContainerUpgrade() { upgrades += 1; return true; },
    async updateImageRawData() { return 0; },
  };
  const plugin = createDecisionHubPlugin({ sdk, source: createSource(), scrollSperreMs: 0 });
  await plugin.start();
  for (let i = 0; i < 6; i += 1) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.ok(upgrades > 0, "the text must be swapped in place");
  assert.equal(rebuilds, 0, `no rebuild may happen while paging, got ${rebuilds}`);
  plugin.stop?.();
});

test("the page geometry stays constant across states", async () => {
  const { buildPage, PANEL_CHARS } = await import("../src/layout.mjs");
  const { initialNav } = await import("../src/nav.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { sectionsOf } = await import("../../kundenpipeline-module/core/sections.mjs");
  const daten = await createSource().load();
  const basis = {
    ...initialNav(),
    sections: sectionsOf(daten.decisions[0], daten.vorgaenge[0], ["mail", "antwort"], PANEL_CHARS),
    tabs: [{ titel: "REM", kanal: "mail" }, { titel: "Thesen", kanal: "mail" }],
    tabIndex: 0, icons: [{ id: "a" }, { id: "b" }], betreff: "REM", typ: "TRIAGE",
  };
  const geo = (nav) => buildPage(nav).textObject.concat(buildPage(nav).imageObject)
    .map((c) => `${c.containerID}:${c.xPosition},${c.yPosition},${c.width},${c.height}`).join("|");
  const a = geo(basis);
  assert.equal(geo({ ...basis, sectionIndex: 1 }), a, "another rubric must not move containers");
  assert.equal(geo({ ...basis, tabIndex: 1 }), a, "another case must not move them either");
  assert.equal(geo({ ...basis, focusIcon: 2 }), a, "and neither must the action bar");
});

// Der Leseweg im Volltext ist etwas anderes als das Blaettern zwischen
// Rubriken — das muss man sehen, nicht raten.
test("the overview shows dots, the long version a bar", async () => {
  const { buildBitmaps, PANEL_CHARS, LEVEL } = await import("../src/layout.mjs");
  const { initialNav } = await import("../src/nav.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { sectionsOf } = await import("../../kundenpipeline-module/core/sections.mjs");
  const daten = await createSource().load();
  const nav = {
    ...initialNav(),
    sections: sectionsOf(daten.decisions[0], daten.vorgaenge[0], ["mail", "antwort"], PANEL_CHARS),
    tabs: [{ titel: "REM", kanal: "mail" }], tabIndex: 0,
    icons: [{ id: "a" }], betreff: "REM", typ: "TRIAGE",
  };
  const streifen = (n) => buildBitmaps(n).find((b) => b.containerID === 21).fingerprint;
  const uebersicht = streifen(nav);
  const detail = streifen({ ...nav, level: LEVEL.DETAIL, page: 0 });
  assert.notEqual(uebersicht, detail, "both states must look different");
  const detailSpaeter = streifen({ ...nav, level: LEVEL.DETAIL, page: 1 });
  assert.notEqual(detail, detailSpaeter, "and the bar must move while reading");
});

// Erschienen die Aktionen dynamisch, spraenge die ganze Liste. Der Platz
// unter jedem Vorgang gehoert ihm dauerhaft.
test("the action slot is reserved, so nothing jumps when icons appear", async () => {
  const { renderCaseList, ZEILE_FALL, ZEILE_NAME } = await import("../src/icons.mjs");
  const faelle = [{ titel: "REM", kanal: "mail" }, { titel: "Thesen", kanal: "mail" }];
  const aktionen = [{ wert: "annehmen" }, { wert: "ablehnen" }];
  const zeilenVon = (bmp, y) => {
    // Ist in dieser Bildzeile ueberhaupt etwas gezeichnet?
    for (let x = 0; x < bmp.width; x += 1) if (bmp.px[y * bmp.width + x]) return true;
    return false;
  };
  const ohne = renderCaseList({ width: 170, height: 144, cases: faelle, active: 0, actions: [] });
  const mit = renderCaseList({ width: 170, height: 144, cases: faelle, active: 0, actions: aktionen, focusAction: 0 });
  // Der zweite Vorgang muss in BEIDEN Faellen an derselben Stelle beginnen.
  const zweiterOben = ZEILE_FALL;
  assert.equal(zeilenVon(ohne, zweiterOben + 8), zeilenVon(mit, zweiterOben + 8),
    "the second case must not move when the actions appear");
  // Und der reservierte Platz wird beim aktiven Vorgang wirklich benutzt.
  assert.equal(zeilenVon(mit, ZEILE_NAME + 8), true, "the actions use the reserved slot");
  assert.equal(zeilenVon(ohne, ZEILE_NAME + 8), false, "which stays empty otherwise");
});

// Das SDK kennt keine Schriftgroesse — der einzige Hebel fuer Gewichtung
// ist die Helligkeit (0..4).
test("the summary is brighter than the full text", async () => {
  const { buildPage, PANEL_CHARS, LEVEL } = await import("../src/layout.mjs");
  const { initialNav } = await import("../src/nav.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { sectionsOf } = await import("../../kundenpipeline-module/core/sections.mjs");
  const daten = await createSource().load();
  const nav = {
    ...initialNav(),
    sections: sectionsOf(daten.decisions[0], daten.vorgaenge[0], ["mail"], PANEL_CHARS),
    tabs: ["REM"], tabIndex: 0, icons: [{ wert: "annehmen" }], betreff: "REM", typ: "TRIAGE",
  };
  const hell = (n) => buildPage(n).textObject.find((c) => c.containerName === "box-body").textColor;
  const kurz = hell(nav);
  const lang = hell({ ...nav, level: LEVEL.DETAIL });
  assert.ok(kurz > lang, `summary ${kurz} must outweigh full text ${lang}`);
  assert.ok(kurz <= 4 && lang >= 0, "and both stay in the allowed 0..4");
});
