// Even-Hub-Plugin: Decision Hub auf der Brille.
//
// Läuft als Web-App auf dem Handy; die Brille ist Anzeige und Eingabe.
// Der Code hier ist bewusst dünn: Ansicht kommt aus buildView(), Layout aus
// view-to-containers, Gesten aus input.mjs. Alle drei sind ohne Hardware
// getestet — dieses Modul verdrahtet sie nur mit dem SDK und der Datenquelle.

import { buildView } from "../../kundenpipeline-module/core/glasses-renderer.mjs";
import { viewToPageContainer, viewToTextUpdates } from "./view-to-containers.mjs";
import { reduce } from "./input.mjs";

export function createDecisionHubPlugin({
  sdk,
  source,
  onError = () => {},
  onPaint = () => {},
  filter = () => true,
}) {
  const state = { scroll: 0, focusIcon: -1, index: 0, detail: 0 };
  let decisions = [];
  let vorgaenge = new Map();
  let started = false;

  const currentView = () =>
    buildView({
      decisions,
      index: Math.min(state.index, Math.max(0, decisions.length - 1)),
      focusIcon: state.focusIcon,
      scroll: state.scroll,
      vorgangOf: (d) => vorgaenge.get(d.vorgang_id),
      copy: {},
      detail: state.detail,
    });

  let lastFocus = null;

  async function paint() {
    const view = currentView();
    onPaint(view);
    if (!view) return;
    if (!started) {
      const result = await sdk.createStartUpPageContainer(viewToPageContainer(view));
      // 0 = Erfolg; alles andere ist ein echter Fehler und darf nicht als
      // "laeuft schon" durchgehen.
      if (result !== 0 && result?.code !== 0) {
        throw new Error(`createStartUpPageContainer failed: ${JSON.stringify(result)}`);
      }
      started = true;
      lastFocus = view.focusIcon;
      return;
    }
    // Wandert der Fokus, aendert sich der STIL der Aktionskaestchen (Rahmen,
    // Helligkeit) — das traegt textContainerUpgrade nicht, dafuer muss die
    // Seite neu aufgebaut werden. Sonst bliebe der Fokus unsichtbar.
    if (view.focusIcon !== lastFocus) {
      await sdk.rebuildPageContainer(viewToPageContainer(view));
      lastFocus = view.focusIcon;
      return;
    }
    for (const update of viewToTextUpdates(view)) await sdk.textContainerUpgrade(update);
  }

  async function refresh() {
    const data = await source.load();
    // Der Filter kommt aus den Handy-Einstellungen: die Brille zeigt nur,
    // was der Besitzer unterwegs sehen will.
    decisions = (data.decisions || []).filter(filter);
    vorgaenge = new Map((data.vorgaenge || []).map((v) => [v.id, v]));
    if (state.index >= decisions.length) {
      state.index = 0;
      state.scroll = 0;
      state.focusIcon = -1;
    }
    await paint();
  }

  /** Eine Entscheidung ausfuehren — von der Brille, vom Handy, egal woher. */
  async function act(wert) {
    const decision = decisions[state.index];
    if (!decision) return;
    if (wert === "detail") {
      // Aus- und Einklappen bleibt im selben Vorgang: an den Anfang und
      // zurueck in den Text, damit man sofort weiterliest.
      state.detail = state.detail >= 1 ? 0 : 1;
      state.scroll = 0;
      state.focusIcon = -1;
      await paint();
      return;
    }
    if (wert === "naechster") {
      state.index = (state.index + 1) % Math.max(1, decisions.length);
      state.scroll = 0;
      await paint();
      return;
    }
    if (wert === "vertagt") {
      // Vertagen bleibt offen und wandert ans Ende der Queue.
      decisions.push(decisions.splice(state.index, 1)[0]);
      state.index = Math.min(state.index, Math.max(0, decisions.length - 1));
      state.scroll = 0;
      await paint();
      return;
    }
    await source.answer({ decision, wert });
    await refresh();
  }



  async function handleEvent(osEvent) {
    const view = currentView();
    if (!view) return;
    const dims = {
      lineCount: view.zeilen.length,
      iconCount: view.icons.length,
      itemCount: decisions.length,
    };
    const { state: next, action } = reduce(state, osEvent, dims);
    Object.assign(state, next);
    if (action?.type === "activate") {
      const icon = view.icons[action.icon];
      // Ein Pfad fuer alle Oberflaechen. Versand und Delegation passieren
      // serverseitig nach der Antwort — das Plugin sendet nie selbst.
      if (icon?.wert) await act(icon.wert);
      return;
    }
    await paint();
  }

  return {
    async start() {
      try {
        await refresh();
      } catch (error) {
        onError(error);
        throw error;
      }
    },
    handleEvent: (osEvent) => handleEvent(osEvent).catch(onError),
    act: (wert) => act(wert).catch(onError),
    refresh: () => refresh().catch(onError),
    get state() {
      return { ...state, count: decisions.length };
    },
    /** Rohdaten fuer die Handy-Oberflaeche (die Brille bekommt currentView()). */
    snapshot() {
      return {
        decisions,
        index: Math.min(state.index, Math.max(0, decisions.length - 1)),
        vorgangOf: (d) => vorgaenge.get(d?.vorgang_id),
      };
    },
    /** Sichtprobe: zeigt, dass die Kette bis auf die Brille traegt. */
    async showTestCard() {
      const now = new Date().toLocaleTimeString("de-DE");
      decisions = [
        {
          id: "testkarte",
          vorgang_id: "testkarte",
          typ: "zuordnung",
          titel: "Testkarte",
          status: "offen",
          zeilen_json: [
            "» TESTKARTE",
            `Gesendet um ${now}.`,
            "Wenn du das liest, traegt die Kette.",
          ],
        },
      ];
      vorgaenge = new Map([["testkarte", { id: "testkarte", kunde_name: "Test" }]]);
      state.index = 0;
      state.scroll = 0;
      await paint();
    },
    async select(index) {
      state.index = index;
      state.scroll = 0;
      state.focusIcon = -1;
      await paint();
    },
  };
}
