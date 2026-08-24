// Unit-Tests gegen die dokumentierten Firmware-Limits (firmware.md,
// design.md), nicht gegen den Simulator -- der ist grosszuegiger als das
// echte Geraet.

import test from "node:test";
import assert from "node:assert/strict";
import { addItem, createEmptyState, setChecked } from "../src/state.js";
import {
  buildGlassesPage,
  formatItemLabel,
  truncateToBytes,
  LIST_CONTAINER_ID,
  STATUS_TEXT_CONTAINER_ID,
  MAX_LIST_ITEMS,
  MAX_ITEM_NAME_BYTES,
} from "../src/glassesLayout.js";
import { validatePageLayout, ValidationError } from "../src/validate.js";

function listOf(n, dept = "Sonstiges") {
  let state = createEmptyState();
  for (let i = 0; i < n; i++) state = addItem(state, `Artikel ${i}`, dept);
  return state;
}

test("eine Seite mit offenen Items besteht die Firmware-Validierung", () => {
  const state = listOf(5);
  const page = buildGlassesPage(state.items);
  assert.equal(page.done, false);
  assert.doesNotThrow(() => validatePageLayout(page));
});

test("die Fertig-Seite (alles abgehakt) besteht die Validierung", () => {
  let state = addItem(createEmptyState(), "Milch", "Molkerei");
  state = setChecked(state, state.items[0].id, true);
  const page = buildGlassesPage(state.items);
  assert.equal(page.done, true);
  assert.equal(page.textObject[0].content, "Fertig.");
  assert.doesNotThrow(() => validatePageLayout(page));
});

test("eine wirklich leere Liste zeigt 'Liste leer.', nicht 'Fertig.'", () => {
  const page = buildGlassesPage([]);
  assert.equal(page.done, true);
  assert.equal(page.textObject[0].content, "Liste leer.");
});

test("containerTotalNum entspricht der echten Containerzahl (Liste und Fertig-Seite)", () => {
  for (const state of [listOf(3), (() => {
    let s = addItem(createEmptyState(), "A", "Sonstiges");
    return setChecked(s, s.items[0].id, true);
  })()]) {
    const page = buildGlassesPage(state.items);
    const real = page.textObject.length + page.imageObject.length + page.listObject.length;
    assert.equal(page.containerTotalNum, real);
  }
});

test("max 1..12 Container gesamt, keine Bild-Container verwendet", () => {
  const page = buildGlassesPage(listOf(5).items);
  assert.equal(page.imageObject.length, 0, "design.md verbietet Flaechenfuellungen -- kein Bitmap-Listing mehr");
  const total = page.textObject.length + page.imageObject.length + page.listObject.length;
  assert.ok(total >= 1 && total <= 12);
});

test("containerID ist eindeutig", () => {
  const page = buildGlassesPage(listOf(3).items);
  const ids = [...page.textObject, ...page.imageObject, ...page.listObject].map((c) => c.containerID);
  assert.equal(new Set(ids).size, ids.length);
});

test("die Liste nutzt isItemSelectBorderEn:1 (native OS-Auswahl statt Bitmap-Inversion)", () => {
  const page = buildGlassesPage(listOf(3).items);
  assert.equal(page.listObject[0].itemContainer.isItemSelectBorderEn, 1);
  assert.equal(page.listObject[0].isEventCapture, 1);
});

test("die Liste fuellt die volle Canvas mit Rand statt einer kleinen Box in der Ecke", () => {
  const page = buildGlassesPage(listOf(3).items);
  const l = page.listObject[0];
  assert.ok(l.xPosition <= 10 && l.yPosition <= 10, "startet nahe am Rand, nicht in einer Ecke");
  assert.ok(l.width >= 500, "nutzt die volle Breite");
  assert.ok(l.height >= 200, "nutzt die volle Hoehe");
});

test("die Liste hat kein Fuellfeld -- nur border* Felder (design.md: no background fills)", () => {
  const page = buildGlassesPage(listOf(3).items);
  const l = page.listObject[0];
  assert.equal(Object.prototype.hasOwnProperty.call(l, "fill"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(l, "backgroundColor"), false);
});

test("indexMap uebersetzt einen Listenindex zurueck auf die echte Item-ID", () => {
  const state = listOf(3);
  const page = buildGlassesPage(state.items);
  const unfinishedIds = state.items.map((i) => i.id);
  assert.deepEqual(page.indexMap, unfinishedIds);
});

test("formatItemLabel stellt den Abteilungscode voran", () => {
  const label = formatItemLabel({ text: "Äpfel", dept: "Obst & Gemüse" });
  assert.match(label, /^OBST\s+Äpfel$/);
});

// --- Negative Kontrollen: die Tests muessen wirklich beissen -------------

test("Validierung schlaegt bei falschem containerTotalNum fehl", () => {
  const page = buildGlassesPage(listOf(2).items);
  const bad = { ...page, containerTotalNum: page.containerTotalNum + 1 };
  assert.throws(() => validatePageLayout(bad), ValidationError);
});

test("Validierung schlaegt bei doppelter containerID fehl", () => {
  const page = buildGlassesPage(listOf(2).items);
  const bad = {
    ...page,
    textObject: [{ containerID: LIST_CONTAINER_ID, width: 4, height: 4, content: "" }],
    containerTotalNum: page.containerTotalNum + 1,
  };
  assert.throws(() => validatePageLayout(bad), /doppelte containerID/);
});

test("buildGlassesPage kappt selbst grosse Listen defensiv auf MAX_LIST_ITEMS", () => {
  const page = buildGlassesPage(listOf(MAX_LIST_ITEMS + 5).items);
  assert.equal(page.listObject[0].itemContainer.itemName.length, MAX_LIST_ITEMS);
  assert.doesNotThrow(() => validatePageLayout(page));
});

test("Validierung schlaegt bei mehr als MAX_LIST_ITEMS Eintraegen fehl (Rohlayout ohne die eigene Kappung)", () => {
  const page = buildGlassesPage(listOf(5).items);
  const names = Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => `Artikel ${i}`);
  const bad = {
    ...page,
    listObject: [
      { ...page.listObject[0], itemContainer: { ...page.listObject[0].itemContainer, itemCount: names.length, itemName: names } },
    ],
  };
  assert.throws(() => validatePageLayout(bad), /zu viele Listeneintraege/);
});

test("Validierung schlaegt bei itemCount/itemName-Mismatch fehl", () => {
  const page = buildGlassesPage(listOf(3).items);
  const bad = {
    ...page,
    listObject: [
      { ...page.listObject[0], itemContainer: { ...page.listObject[0].itemContainer, itemCount: 99 } },
    ],
  };
  assert.throws(() => validatePageLayout(bad), /itemCount/);
});

test("Validierung schlaegt bei zu langem Listenlabel fehl (> 63 UTF-8-Byte)", () => {
  const page = buildGlassesPage(listOf(1).items);
  const tooLong = "x".repeat(MAX_ITEM_NAME_BYTES + 10);
  const bad = {
    ...page,
    listObject: [
      {
        ...page.listObject[0],
        itemContainer: { ...page.listObject[0].itemContainer, itemName: [tooLong] },
      },
    ],
  };
  assert.throws(() => validatePageLayout(bad), /ueberschreitet/);
});

test("Validierung schlaegt bei mehr als 8 Text-Containern fehl", () => {
  const extraText = Array.from({ length: 9 }, (_, i) => ({
    containerID: 100 + i,
    width: 4,
    height: 4,
    content: "",
  }));
  const bad = { containerTotalNum: extraText.length, textObject: extraText, imageObject: [], listObject: [] };
  assert.throws(() => validatePageLayout(bad), /Text-Container/);
});

test("Validierung schlaegt bei isEventCapture:1 auf sichtbarer Textflaeche fehl", () => {
  const bad = {
    containerTotalNum: 1,
    textObject: [{ containerID: 1, width: 200, height: 40, content: "x", isEventCapture: 1 }],
    imageObject: [],
    listObject: [],
  };
  assert.throws(() => validatePageLayout(bad), /OS-Scroll-Bounce/);
});

test("Validierung erlaubt isEventCapture:1 auf dem grossflaechigen listObject", () => {
  const page = buildGlassesPage(listOf(2).items);
  assert.doesNotThrow(() => validatePageLayout(page));
});

// --- truncateToBytes --------------------------------------------------------

test("truncateToBytes laesst kurze Texte unveraendert", () => {
  assert.equal(truncateToBytes("Milch", MAX_ITEM_NAME_BYTES), "Milch");
});

test("truncateToBytes kuerzt lange Texte auf das Byte-Limit inklusive Ellipse", () => {
  const long = "Sehr sehr sehr sehr sehr sehr sehr sehr sehr langer Artikelname mit Ümlauten";
  const out = truncateToBytes(long, MAX_ITEM_NAME_BYTES);
  assert.ok(out.endsWith("…"));
  const bytes = Buffer.byteLength(out, "utf8");
  assert.ok(bytes <= MAX_ITEM_NAME_BYTES, `${bytes} <= ${MAX_ITEM_NAME_BYTES}`);
});
