// Telefon-Ansicht: normales DOM/CSS im Even-App-WebView. Keine
// Brillen-Limits gelten hier -- das ist die komfortable Bearbeitungsflaeche.

import { DEPARTMENTS, sortedByDepartment } from "./state.js";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(c);
  }
  return node;
}

function departmentOptions(selected) {
  return DEPARTMENTS.map((d) => {
    const opt = el("option", { value: d, text: d });
    if (d === selected) opt.selected = true;
    return opt;
  });
}

/**
 * Baut die Telefon-Ansicht in `root`. Callbacks fuehren die tatsaechliche
 * Zustandsaenderung aus (in main.js), diese Funktion ist reines Rendering
 * plus Event-Wiring und wird nach jeder Aenderung neu aufgerufen (kleine
 * Liste -> voller Re-Render ist billiger als Diffing).
 */
// Modul-Zustand statt lokaler Variable: `renderPhoneView` wird bei jeder
// Aenderung komplett neu aufgerufen (voller Re-Render statt Diffing), eine
// `let editingId` INNERHALB der Funktion wuerde also bei jedem `rerender()`
// auf null zurueckgesetzt, bevor sie je gelesen wird -- der Bearbeiten-Klick
// haette nie sichtbar etwas bewirkt. Muss ausserhalb der Funktion leben, um
// einen Render-Aufruf zu ueberleben.
let editingId = null;

export function renderPhoneView(root, state, actions) {
  root.innerHTML = "";

  function rerender() {
    renderPhoneView(root, state, actions);
  }

  // -- Kopfzeile ------------------------------------------------------
  const openCount = state.items.filter((it) => !it.checked).length;
  const header = el("header", { class: "app-header" }, [
    el("h1", { text: "Einkaufsliste" }),
    el("p", { class: "subtitle", text: openCount === 0 ? "Alles erledigt" : `${openCount} offen` }),
  ]);

  // -- Formular: neues Item hinzufuegen --------------------------------
  const textInput = el("input", {
    type: "text",
    class: "item-input",
    placeholder: "Artikel eingeben…",
    "aria-label": "Artikeltext",
  });
  const deptSelect = el(
    "select",
    { class: "dept-select", "aria-label": "Abteilung" },
    departmentOptions(),
  );

  function submitAdd() {
    const text = textInput.value.trim();
    if (!text) return;
    actions.onAdd(text, deptSelect.value);
    textInput.value = "";
    textInput.focus();
  }

  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAdd();
  });

  const addForm = el("div", { class: "add-form" }, [
    textInput,
    deptSelect,
    el("button", { class: "btn btn-primary", text: "Hinzufügen", onclick: submitAdd }),
  ]);

  // -- Liste, gruppiert nach Abteilung ---------------------------------
  const listWrap = el("div", { class: "list-wrap" });
  const sorted = sortedByDepartment(state.items);

  if (sorted.length === 0) {
    listWrap.appendChild(
      el("p", { class: "empty-state", text: "Deine Liste ist leer. Füge oben ein Produkt hinzu." }),
    );
  } else {
    let lastDept = null;
    for (const item of sorted) {
      if (item.dept !== lastDept) {
        lastDept = item.dept;
        listWrap.appendChild(el("h2", { class: "dept-heading", text: item.dept }));
      }

      if (editingId === item.id) {
        const editText = el("input", { type: "text", class: "item-input", value: item.text });
        const editDept = el("select", { class: "dept-select" }, departmentOptions(item.dept));
        const save = () => {
          actions.onEdit(item.id, { text: editText.value, dept: editDept.value });
          editingId = null;
          rerender();
        };
        const row = el("div", { class: "item-row editing" }, [
          editText,
          editDept,
          el("button", { class: "btn btn-small btn-primary", text: "Speichern", onclick: save }),
          el("button", {
            class: "btn btn-small",
            text: "Abbrechen",
            onclick: () => {
              editingId = null;
              rerender();
            },
          }),
        ]);
        listWrap.appendChild(row);
        continue;
      }

      const checkbox = el("input", { type: "checkbox" });
      checkbox.checked = item.checked;
      checkbox.addEventListener("change", () => actions.onToggle(item.id));

      const row = el("div", { class: item.checked ? "item-row checked" : "item-row" }, [
        el("label", { class: "item-check" }, [
          checkbox,
          el("span", { class: "item-text", text: item.text }),
        ]),
        el("div", { class: "item-actions" }, [
          el("button", {
            class: "btn btn-icon",
            "aria-label": "Bearbeiten",
            text: "✎",
            onclick: () => {
              editingId = item.id;
              rerender();
            },
          }),
          el("button", {
            class: "btn btn-icon btn-danger",
            "aria-label": "Löschen",
            text: "✕",
            onclick: () => actions.onRemove(item.id),
          }),
        ]),
      ]);
      listWrap.appendChild(row);
    }
  }

  // -- Fusszeile --------------------------------------------------------
  const hasChecked = state.items.some((it) => it.checked);
  const footer = el("footer", { class: "app-footer" }, [
    el("button", {
      class: "btn btn-secondary",
      text: "Erledigte entfernen",
      disabled: hasChecked ? undefined : "disabled",
      onclick: () => actions.onClearChecked(),
    }),
  ]);
  if (!hasChecked) footer.querySelector("button").disabled = true;

  root.appendChild(header);
  root.appendChild(addForm);
  root.appendChild(listWrap);
  root.appendChild(footer);
}
