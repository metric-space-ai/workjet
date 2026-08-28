import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  DEPARTMENTS,
  createEmptyState,
  addItem,
  editItem,
  removeItem,
  toggleChecked,
  setChecked,
  clearChecked,
  sortedByDepartment,
} from "../src/state.js";

NodeTest("addItem fuegt ein getrimmtes Item mit gueltiger Abteilung hinzu", () => {
  let state = createEmptyState();
  state = addItem(state, "  Äpfel  ", "Obst & Gemüse");
  NodeAssert.equal(state.items.length, 1);
  NodeAssert.equal(state.items[0].text, "Äpfel");
  NodeAssert.equal(state.items[0].dept, "Obst & Gemüse");
  NodeAssert.equal(state.items[0].checked, false);
});

NodeTest("addItem ignoriert leeren Text", () => {
  let state = createEmptyState();
  state = addItem(state, "   ", "Molkerei");
  NodeAssert.equal(state.items.length, 0);
});

NodeTest("addItem faengt unbekannte Abteilung auf Sonstiges ab", () => {
  let state = createEmptyState();
  state = addItem(state, "Ding", "Nicht-existent");
  NodeAssert.equal(state.items[0].dept, "Sonstiges");
});

NodeTest("editItem aktualisiert Text und Abteilung", () => {
  let state = addItem(createEmptyState(), "Milch", "Molkerei");
  const id = state.items[0].id;
  state = editItem(state, id, { text: "Hafermilch", dept: "Getränke" });
  NodeAssert.equal(state.items[0].text, "Hafermilch");
  NodeAssert.equal(state.items[0].dept, "Getränke");
});

NodeTest("editItem mit leerem Text laesst den alten Text stehen", () => {
  let state = addItem(createEmptyState(), "Milch", "Molkerei");
  const id = state.items[0].id;
  state = editItem(state, id, { text: "   " });
  NodeAssert.equal(state.items[0].text, "Milch");
});

NodeTest("removeItem entfernt genau das eine Item", () => {
  let state = addItem(createEmptyState(), "A", "Sonstiges");
  state = addItem(state, "B", "Sonstiges");
  const idToRemove = state.items[0].id;
  state = removeItem(state, idToRemove);
  NodeAssert.equal(state.items.length, 1);
  NodeAssert.equal(state.items[0].text, "B");
});

NodeTest("toggleChecked und setChecked schalten den Haken", () => {
  let state = addItem(createEmptyState(), "A", "Sonstiges");
  const id = state.items[0].id;
  state = toggleChecked(state, id);
  NodeAssert.equal(state.items[0].checked, true);
  state = toggleChecked(state, id);
  NodeAssert.equal(state.items[0].checked, false);
  state = setChecked(state, id, true);
  NodeAssert.equal(state.items[0].checked, true);
});

NodeTest("clearChecked entfernt nur abgehakte Items", () => {
  let state = addItem(createEmptyState(), "A", "Sonstiges");
  state = addItem(state, "B", "Sonstiges");
  state = setChecked(state, state.items[0].id, true);
  state = clearChecked(state);
  NodeAssert.equal(state.items.length, 1);
  NodeAssert.equal(state.items[0].text, "B");
});

NodeTest("sortedByDepartment folgt der Ladenrundgang-Reihenfolge", () => {
  let state = addItem(createEmptyState(), "Bier", "Getränke");
  state = addItem(state, "Apfel", "Obst & Gemüse");
  state = addItem(state, "Wurst", "Fleisch");
  const sorted = sortedByDepartment(state.items);
  const depts = sorted.map((i) => i.dept);
  const order = depts.map((d) => DEPARTMENTS.indexOf(d));
  for (let i = 1; i < order.length; i++) {
    NodeAssert.ok(order[i] >= order[i - 1], "Reihenfolge muss der DEPARTMENTS-Liste folgen");
  }
});

NodeTest("alle 8 geforderten Abteilungen sind vorhanden", () => {
  const required = [
    "Obst & Gemüse",
    "Molkerei",
    "Fleisch",
    "Backwaren",
    "Getränke",
    "Tiefkühl",
    "Haushalt",
    "Sonstiges",
  ];
  NodeAssert.deepEqual(DEPARTMENTS, required);
});
