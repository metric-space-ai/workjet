// Unit-Tests gegen die dokumentierten Firmware-Limits (firmware.md,
// design.md), nicht gegen den Simulator -- der ist grosszuegiger als das
// echte Geraet.

import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { addItem, createEmptyState, setChecked } from "../src/state.js";
import {
  buildGlassesPage,
  formatItemLabel,
  truncateToBytes,
  LIST_CONTAINER_ID,
  MAX_LIST_ITEMS,
  MAX_ITEM_NAME_BYTES,
} from "../src/glassesLayout.js";
import { validatePageLayout, ValidationError } from "../src/validate.js";

function listOf(n, dept = "Sonstiges") {
  let state = createEmptyState();
  for (let i = 0; i < n; i++) state = addItem(state, `Artikel ${i}`, dept);
  return state;
}

NodeTest("eine Seite mit offenen Items besteht die Firmware-Validierung", () => {
  const state = listOf(5);
  const page = buildGlassesPage(state.items);
  NodeAssert.equal(page.done, false);
  NodeAssert.doesNotThrow(() => validatePageLayout(page));
});

NodeTest("die Fertig-Seite (alles abgehakt) besteht die Validierung", () => {
  let state = addItem(createEmptyState(), "Milch", "Molkerei");
  state = setChecked(state, state.items[0].id, true);
  const page = buildGlassesPage(state.items);
  NodeAssert.equal(page.done, true);
  NodeAssert.equal(page.textObject[0].content, "Fertig.");
  NodeAssert.doesNotThrow(() => validatePageLayout(page));
});

NodeTest("eine wirklich leere Liste zeigt 'Liste leer.', nicht 'Fertig.'", () => {
  const page = buildGlassesPage([]);
  NodeAssert.equal(page.done, true);
  NodeAssert.equal(page.textObject[0].content, "Liste leer.");
});

NodeTest("containerTotalNum entspricht der echten Containerzahl (Liste und Fertig-Seite)", () => {
  for (const state of [
    listOf(3),
    (() => {
      let s = addItem(createEmptyState(), "A", "Sonstiges");
      return setChecked(s, s.items[0].id, true);
    })(),
  ]) {
    const page = buildGlassesPage(state.items);
    const real = page.textObject.length + page.imageObject.length + page.listObject.length;
    NodeAssert.equal(page.containerTotalNum, real);
  }
});

NodeTest("max 1..12 Container gesamt, keine Bild-Container verwendet", () => {
  const page = buildGlassesPage(listOf(5).items);
  NodeAssert.equal(
    page.imageObject.length,
    0,
    "design.md verbietet Flaechenfuellungen -- kein Bitmap-Listing mehr",
  );
  const total = page.textObject.length + page.imageObject.length + page.listObject.length;
  NodeAssert.ok(total >= 1 && total <= 12);
});

NodeTest("containerID ist eindeutig", () => {
  const page = buildGlassesPage(listOf(3).items);
  const ids = [...page.textObject, ...page.imageObject, ...page.listObject].map(
    (c) => c.containerID,
  );
  NodeAssert.equal(new Set(ids).size, ids.length);
});

NodeTest(
  "die Liste nutzt isItemSelectBorderEn:1 (native OS-Auswahl statt Bitmap-Inversion)",
  () => {
    const page = buildGlassesPage(listOf(3).items);
    NodeAssert.equal(page.listObject[0].itemContainer.isItemSelectBorderEn, 1);
    NodeAssert.equal(page.listObject[0].isEventCapture, 1);
  },
);

NodeTest("die Liste fuellt die volle Canvas mit Rand statt einer kleinen Box in der Ecke", () => {
  const page = buildGlassesPage(listOf(3).items);
  const l = page.listObject[0];
  NodeAssert.ok(
    l.xPosition <= 10 && l.yPosition <= 10,
    "startet nahe am Rand, nicht in einer Ecke",
  );
  NodeAssert.ok(l.width >= 500, "nutzt die volle Breite");
  NodeAssert.ok(l.height >= 200, "nutzt die volle Hoehe");
});

NodeTest(
  "die Liste hat kein Fuellfeld -- nur border* Felder (design.md: no background fills)",
  () => {
    const page = buildGlassesPage(listOf(3).items);
    const l = page.listObject[0];
    NodeAssert.equal(Object.prototype.hasOwnProperty.call(l, "fill"), false);
    NodeAssert.equal(Object.prototype.hasOwnProperty.call(l, "backgroundColor"), false);
  },
);

NodeTest("indexMap uebersetzt einen Listenindex zurueck auf die echte Item-ID", () => {
  const state = listOf(3);
  const page = buildGlassesPage(state.items);
  const unfinishedIds = state.items.map((i) => i.id);
  NodeAssert.deepEqual(page.indexMap, unfinishedIds);
});

NodeTest("formatItemLabel stellt den Abteilungscode voran", () => {
  const label = formatItemLabel({ text: "Äpfel", dept: "Obst & Gemüse" });
  NodeAssert.match(label, /^OBST\s+Äpfel$/);
});

// --- Negative Kontrollen: die Tests muessen wirklich beissen -------------

NodeTest("Validierung schlaegt bei falschem containerTotalNum fehl", () => {
  const page = buildGlassesPage(listOf(2).items);
  const bad = { ...page, containerTotalNum: page.containerTotalNum + 1 };
  NodeAssert.throws(() => validatePageLayout(bad), ValidationError);
});

NodeTest("Validierung schlaegt bei doppelter containerID fehl", () => {
  const page = buildGlassesPage(listOf(2).items);
  const bad = {
    ...page,
    textObject: [{ containerID: LIST_CONTAINER_ID, width: 4, height: 4, content: "" }],
    containerTotalNum: page.containerTotalNum + 1,
  };
  NodeAssert.throws(() => validatePageLayout(bad), /doppelte containerID/);
});

NodeTest("buildGlassesPage kappt selbst grosse Listen defensiv auf MAX_LIST_ITEMS", () => {
  const page = buildGlassesPage(listOf(MAX_LIST_ITEMS + 5).items);
  NodeAssert.equal(page.listObject[0].itemContainer.itemName.length, MAX_LIST_ITEMS);
  NodeAssert.doesNotThrow(() => validatePageLayout(page));
});

NodeTest(
  "Validierung schlaegt bei mehr als MAX_LIST_ITEMS Eintraegen fehl (Rohlayout ohne die eigene Kappung)",
  () => {
    const page = buildGlassesPage(listOf(5).items);
    const names = Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => `Artikel ${i}`);
    const bad = {
      ...page,
      listObject: [
        {
          ...page.listObject[0],
          itemContainer: {
            ...page.listObject[0].itemContainer,
            itemCount: names.length,
            itemName: names,
          },
        },
      ],
    };
    NodeAssert.throws(() => validatePageLayout(bad), /zu viele Listeneintraege/);
  },
);

NodeTest("Validierung schlaegt bei itemCount/itemName-Mismatch fehl", () => {
  const page = buildGlassesPage(listOf(3).items);
  const bad = {
    ...page,
    listObject: [
      {
        ...page.listObject[0],
        itemContainer: { ...page.listObject[0].itemContainer, itemCount: 99 },
      },
    ],
  };
  NodeAssert.throws(() => validatePageLayout(bad), /itemCount/);
});

NodeTest("Validierung schlaegt bei zu langem Listenlabel fehl (> 63 UTF-8-Byte)", () => {
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
  NodeAssert.throws(() => validatePageLayout(bad), /ueberschreitet/);
});

NodeTest("Validierung schlaegt bei mehr als 8 Text-Containern fehl", () => {
  const extraText = Array.from({ length: 9 }, (_, i) => ({
    containerID: 100 + i,
    width: 4,
    height: 4,
    content: "",
  }));
  const bad = {
    containerTotalNum: extraText.length,
    textObject: extraText,
    imageObject: [],
    listObject: [],
  };
  NodeAssert.throws(() => validatePageLayout(bad), /Text-Container/);
});

NodeTest("Validierung schlaegt bei isEventCapture:1 auf sichtbarer Textflaeche fehl", () => {
  const bad = {
    containerTotalNum: 1,
    textObject: [{ containerID: 1, width: 200, height: 40, content: "x", isEventCapture: 1 }],
    imageObject: [],
    listObject: [],
  };
  NodeAssert.throws(() => validatePageLayout(bad), /OS-Scroll-Bounce/);
});

NodeTest("Validierung erlaubt isEventCapture:1 auf dem grossflaechigen listObject", () => {
  const page = buildGlassesPage(listOf(2).items);
  NodeAssert.doesNotThrow(() => validatePageLayout(page));
});

// --- truncateToBytes --------------------------------------------------------

NodeTest("truncateToBytes laesst kurze Texte unveraendert", () => {
  NodeAssert.equal(truncateToBytes("Milch", MAX_ITEM_NAME_BYTES), "Milch");
});

NodeTest("truncateToBytes kuerzt lange Texte auf das Byte-Limit inklusive Ellipse", () => {
  const long = "Sehr sehr sehr sehr sehr sehr sehr sehr sehr langer Artikelname mit Ümlauten";
  const out = truncateToBytes(long, MAX_ITEM_NAME_BYTES);
  NodeAssert.ok(out.endsWith("…"));
  const bytes = Buffer.byteLength(out, "utf8");
  NodeAssert.ok(bytes <= MAX_ITEM_NAME_BYTES, `${bytes} <= ${MAX_ITEM_NAME_BYTES}`);
});
