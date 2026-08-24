// Datenmodell und Persistenz der Einkaufsliste.
//
// Eine einzige State-Instanz wird sowohl von der Telefon-Ansicht (DOM) als
// auch von der Brillen-Ansicht (Container-Protokoll) gelesen und beschrieben
// -- beide laufen im selben WebView-Prozess. Persistenz ueber plain
// localStorage: einfacher und zuverlaessiger als der SDK-Store, funktioniert
// identisch im Simulator wie im echten WebView.

export const DEPARTMENTS = [
  "Obst & Gemüse",
  "Molkerei",
  "Fleisch",
  "Backwaren",
  "Getränke",
  "Tiefkühl",
  "Haushalt",
  "Sonstiges",
];

const STORAGE_KEY = "shopping-list-glasses:v1";

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Liefert einen frischen, leeren Zustand. */
export function createEmptyState() {
  return { items: [] };
}

/** Laedt den Zustand aus localStorage; liefert einen leeren Zustand bei Fehlern. */
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return createEmptyState();
    // Defensive Normalisierung: nur bekannte Felder, Department-Fallback.
    const items = parsed.items
      .filter((it) => it && typeof it.text === "string" && it.text.trim())
      .map((it) => ({
        id: typeof it.id === "string" ? it.id : makeId(),
        text: String(it.text).trim(),
        dept: DEPARTMENTS.includes(it.dept) ? it.dept : DEPARTMENTS[DEPARTMENTS.length - 1],
        checked: Boolean(it.checked),
      }));
    return { items };
  } catch {
    return createEmptyState();
  }
}

/** Schreibt den Zustand nach localStorage. */
export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage kann im Simulator/WebView fehlschlagen (Quota, privat) --
    // die App bleibt dann in-memory funktionsfaehig fuer die Sitzung.
  }
}

/** Fuegt ein neues Item hinzu und liefert den aktualisierten Zustand. */
export function addItem(state, text, dept) {
  const trimmed = text.trim();
  if (!trimmed) return state;
  const item = {
    id: makeId(),
    text: trimmed,
    dept: DEPARTMENTS.includes(dept) ? dept : DEPARTMENTS[DEPARTMENTS.length - 1],
    checked: false,
  };
  return { items: [...state.items, item] };
}

/** Aktualisiert Text und/oder Abteilung eines Items. */
export function editItem(state, id, changes) {
  return {
    items: state.items.map((it) =>
      it.id === id
        ? {
            ...it,
            text: typeof changes.text === "string" && changes.text.trim() ? changes.text.trim() : it.text,
            dept: changes.dept && DEPARTMENTS.includes(changes.dept) ? changes.dept : it.dept,
          }
        : it,
    ),
  };
}

/** Entfernt ein Item. */
export function removeItem(state, id) {
  return { items: state.items.filter((it) => it.id !== id) };
}

/** Schaltet den Haken eines Items um. */
export function toggleChecked(state, id) {
  return {
    items: state.items.map((it) => (it.id === id ? { ...it, checked: !it.checked } : it)),
  };
}

/** Setzt den Haken eines Items explizit. */
export function setChecked(state, id, checked) {
  return {
    items: state.items.map((it) => (it.id === id ? { ...it, checked } : it)),
  };
}

/** Entfernt alle abgehakten Items. */
export function clearChecked(state) {
  return { items: state.items.filter((it) => !it.checked) };
}

/**
 * Liefert die Items sortiert nach Abteilungsreihenfolge (Ladenrundgang),
 * innerhalb einer Abteilung in Eingabereihenfolge stabil.
 */
export function sortedByDepartment(items) {
  const order = new Map(DEPARTMENTS.map((d, i) => [d, i]));
  return [...items].sort((a, b) => {
    const da = order.get(a.dept) ?? DEPARTMENTS.length;
    const db = order.get(b.dept) ?? DEPARTMENTS.length;
    if (da !== db) return da - db;
    return 0; // stabiler Sort in modernen JS-Engines erhaelt Eingabereihenfolge
  });
}
