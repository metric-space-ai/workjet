import { loadState, saveState, addItem, editItem, removeItem, toggleChecked, setChecked, clearChecked } from "./state.js";
import { renderPhoneView } from "./phoneView.js";
import { createGlassesController } from "./glassesView.js";

const melde = (t) => {
  // Konsolen-Beacon fuer den Simulator/Diagnose (diagnosis.md). Kein
  // Netzwerk-Log-Server noetig fuer die Simulator-Verifikation dieses Tasks.
  try {
    console.log(String(t));
  } catch {
    /* noop */
  }
};

window.addEventListener("error", (e) => melde(`FEHLER ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => melde(`ABBRUCH ${e.reason?.message || e.reason}`));

let state = loadState();

// Nur fuer den Simulator-Verifikationslauf: ?seed=1 auf einer leeren Liste
// fuellt Demo-Artikel ueber mehrere Abteilungen, damit der Interaktions-Walk
// (scrollen/abhaken/fertig) ohne manuelle Telefon-Eingabe reproduzierbar ist.
// Greift nie in Produktion, weil der Query-Parameter dort nie gesetzt wird.
if (new URLSearchParams(location.search).get("seed") === "1" && state.items.length === 0) {
  const demo = [
    ["Bier", "Getränke"],
    ["Äpfel", "Obst & Gemüse"],
    ["Hackfleisch", "Fleisch"],
    ["Brötchen", "Backwaren"],
    ["Joghurt", "Molkerei"],
    ["Erbsen (TK)", "Tiefkühl"],
    ["Spülmittel", "Haushalt"],
    ["Kerzen", "Sonstiges"],
  ];
  for (const [text, dept] of demo) state = addItem(state, text, dept);
  saveState(state);
  melde(`Demo-Items geseedet (${state.items.length})`);
}

melde(`main() gestartet, ${state.items.length} Items geladen`);

const root = document.getElementById("app");

const glasses = createGlassesController({
  getState: () => state,
  onToggleChecked: (id, checked) => {
    state = setChecked(state, id, checked);
    saveState(state);
    rerenderPhone();
  },
  onLog: melde,
});

function rerenderPhone() {
  renderPhoneView(root, state, {
    onAdd: (text, dept) => {
      state = addItem(state, text, dept);
      saveState(state);
      rerenderPhone();
      glasses.notifyStateChanged();
    },
    onEdit: (id, changes) => {
      state = editItem(state, id, changes);
      saveState(state);
      rerenderPhone();
      glasses.notifyStateChanged();
    },
    onRemove: (id) => {
      state = removeItem(state, id);
      saveState(state);
      rerenderPhone();
      glasses.notifyStateChanged();
    },
    onToggle: (id) => {
      state = toggleChecked(state, id);
      saveState(state);
      rerenderPhone();
      glasses.notifyStateChanged();
    },
    onClearChecked: () => {
      state = clearChecked(state);
      saveState(state);
      rerenderPhone();
      glasses.notifyStateChanged();
    },
  });
}

// Telefon-UI immer zeigen, auch wenn die Bruecke zur Brille fehlschlaegt
// (diagnosis.md: "Keep the phone-view alive even when the glasses fail").
rerenderPhone();
melde("Telefon-Ansicht gerendert");

glasses
  .start()
  .then(() => melde("Brillenseite gestartet"))
  .catch((e) => melde(`Brillenseite fehlgeschlagen: ${e?.message || e}`));
