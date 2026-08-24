import test from "node:test";
import assert from "node:assert/strict";
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

test("addItem fuegt ein getrimmtes Item mit gueltiger Abteilung hinzu", () => {
  let state = createEmptyState();
  state = addItem(state, "  Äpfel  ", "Obst & Gemüse");
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, "Äpfel");
  assert.equal(state.items[0].dept, "Obst & Gemüse");
  assert.equal(state.items[0].checked, false);
});

test("addItem ignoriert leeren Text", () => {
  let state = createEmptyState();
  state = addItem(state, "   ", "Molkerei");
  assert.equal(state.items.length, 0);
});

test("addItem faengt unbekannte Abteilung auf Sonstiges ab", () => {
  let state = createEmptyState();
  state = addItem(state, "Ding", "Nicht-existent");
  assert.equal(state.items[0].dept, "Sonstiges");
});

test("editItem aktualisiert Text und Abteilung", () => {
  let state = addItem(createEmptyState(), "Milch", "Molkerei");
  const id = state.items[0].id;
  state = editItem(state, id, { text: "Hafermilch", dept: "Getränke" });
  assert.equal(state.items[0].text, "Hafermilch");
  assert.equal(state.items[0].dept, "Getränke");
});

test("editItem mit leerem Text laesst den alten Text stehen", () => {
  let state = addItem(createEmptyState(), "Milch", "Molkerei");
  const id = state.items[0].id;
  state = editItem(state, id, { text: "   " });
  assert.equal(state.items[0].text, "Milch");
});

test("removeItem entfernt genau das eine Item", () => {
  let state = addItem(createEmptyState(), "A", "Sonstiges");
  state = addItem(state, "B", "Sonstiges");
  const idToRemove = state.items[0].id;
  state = removeItem(state, idToRemove);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, "B");
});

test("toggleChecked und setChecked schalten den Haken", () => {
  let state = addItem(createEmptyState(), "A", "Sonstiges");
  const id = state.items[0].id;
  state = toggleChecked(state, id);
  assert.equal(state.items[0].checked, true);
  state = toggleChecked(state, id);
  assert.equal(state.items[0].checked, false);
  state = setChecked(state, id, true);
  assert.equal(state.items[0].checked, true);
});

test("clearChecked entfernt nur abgehakte Items", () => {
  let state = addItem(createEmptyState(), "A", "Sonstiges");
  state = addItem(state, "B", "Sonstiges");
  state = setChecked(state, state.items[0].id, true);
  state = clearChecked(state);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, "B");
});

test("sortedByDepartment folgt der Ladenrundgang-Reihenfolge", () => {
  let state = addItem(createEmptyState(), "Bier", "Getränke");
  state = addItem(state, "Apfel", "Obst & Gemüse");
  state = addItem(state, "Wurst", "Fleisch");
  const sorted = sortedByDepartment(state.items);
  const depts = sorted.map((i) => i.dept);
  const order = depts.map((d) => DEPARTMENTS.indexOf(d));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] >= order[i - 1], "Reihenfolge muss der DEPARTMENTS-Liste folgen");
  }
});

test("alle 8 geforderten Abteilungen sind vorhanden", () => {
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
  assert.deepEqual(DEPARTMENTS, required);
});
