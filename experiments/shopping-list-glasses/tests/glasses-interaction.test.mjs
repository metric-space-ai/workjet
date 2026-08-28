// Interaktionslogik der Brillenseite: die Liste selbst scrollt nativ auf
// dem Geraet (kein App-Code dafuer noetig, siehe design.md "Motion" /
// interaction.md "The OS list container"). Was die App testen muss: welche
// Items im richtigen Zustand in welcher Reihenfolge auftauchen, und dass ein
// Klick-Index korrekt auf die echte Item-ID zurueckuebersetzt wird.

import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { addItem, createEmptyState, setChecked } from "../src/state.js";
import { unfinishedItems, buildGlassesPage } from "../src/glassesLayout.js";

function listOf(n, dept = "Sonstiges") {
  let state = createEmptyState();
  for (let i = 0; i < n; i++) state = addItem(state, `Artikel ${i}`, dept);
  return state;
}

NodeTest("unfinishedItems blendet abgehakte Items aus und sortiert nach Abteilung", () => {
  let state = addItem(createEmptyState(), "Bier", "Getränke");
  state = addItem(state, "Apfel", "Obst & Gemüse");
  state = setChecked(state, state.items[0].id, true);
  const open = unfinishedItems(state.items);
  NodeAssert.equal(open.length, 1);
  NodeAssert.equal(open[0].text, "Apfel");
});

NodeTest(
  "Abhaken des obersten (aktuell hervorgehobenen) Items laesst das naechste nachruecken",
  () => {
    const state0 = listOf(3); // Artikel 0,1,2, alle Sonstiges -> Eingabereihenfolge
    const page0 = buildGlassesPage(state0.items);
    NodeAssert.equal(page0.listObject[0].itemContainer.itemName[0], "SONST  Artikel 0");

    // Klick auf Index 0 (das aktuell ausgewaehlte, oberste Item) -> abhaken.
    const clickedId = page0.indexMap[0];
    const state1 = setChecked(state0, clickedId, true);
    const page1 = buildGlassesPage(state1.items);
    NodeAssert.equal(page1.listObject[0].itemContainer.itemName[0], "SONST  Artikel 1");
  },
);

NodeTest(
  "ein listEvent-Index uebersetzt sich ueber indexMap auf dieselbe Item-ID wie in der Telefon-Ansicht",
  () => {
    const state = listOf(5);
    const page = buildGlassesPage(state.items);
    const unfinished = unfinishedItems(state.items);
    for (let i = 0; i < unfinished.length; i++) {
      NodeAssert.equal(page.indexMap[i], unfinished[i].id);
    }
  },
);

NodeTest("die Liste ist nach Abteilung sortiert (Ladenrundgang)", () => {
  let state = addItem(createEmptyState(), "Bier", "Getränke");
  state = addItem(state, "Apfel", "Obst & Gemüse");
  state = addItem(state, "Wurst", "Fleisch");
  const page = buildGlassesPage(state.items);
  const labels = page.listObject[0].itemContainer.itemName;
  NodeAssert.deepEqual(labels, ["OBST  Apfel", "FLEISCH  Wurst", "GETR  Bier"]);
});

NodeTest("checked Items verschwinden vollstaendig aus der Brillenliste", () => {
  let state = listOf(3);
  const idToCheck = unfinishedItems(state.items)[1].id;
  state = setChecked(state, idToCheck, true);
  const page = buildGlassesPage(state.items);
  const labels = page.listObject[0].itemContainer.itemName;
  NodeAssert.equal(labels.length, 2);
  NodeAssert.ok(!labels.some((l) => l.includes("Artikel 1")));
});

NodeTest("alles abgehakt -> Fertig-Zustand ohne Liste", () => {
  let state = listOf(2);
  for (const it of state.items) state = setChecked(state, it.id, true);
  const page = buildGlassesPage(state.items);
  NodeAssert.equal(page.done, true);
  NodeAssert.equal(page.listObject.length, 0);
  NodeAssert.equal(page.textObject[0].content, "Fertig.");
});
