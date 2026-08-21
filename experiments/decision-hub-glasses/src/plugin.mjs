// Even-Hub-Plugin: Decision Hub auf der Brille.
//
// Läuft als Web-App auf dem Handy; die Brille ist Anzeige und Eingabe.
// Der Code hier ist bewusst dünn: Ansicht kommt aus buildView(), Layout aus
// view-to-containers, Gesten aus input.mjs. Alle drei sind ohne Hardware
// getestet — dieses Modul verdrahtet sie nur mit dem SDK und der Datenquelle.

import { buildView } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { viewToPageContainer, viewToTextUpdates } from './view-to-containers.mjs';
import { reduce } from './input.mjs';
import { menuAction } from './view-to-containers.mjs';

export function createDecisionHubPlugin({ sdk, source, onError = () => {}, onPaint = () => {} }) {
  const state = { scroll: 0, focusIcon: -1, index: 0 };
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
    });

  async function paint() {
    const view = currentView();
    onPaint(view);
    if (!view) return;
    if (!started) {
      const result = await sdk.createStartUpPageContainer(viewToPageContainer(view));
      // 0 = Erfolg; alles andere ist ein echter Fehler und darf nicht als
      // "läuft schon" durchgehen.
      if (result !== 0 && result?.code !== 0) throw new Error(`createStartUpPageContainer failed: ${JSON.stringify(result)}`);
      started = true;
      return;
    }
    for (const update of viewToTextUpdates(view)) await sdk.textContainerUpgrade(update);
  }

  async function refresh() {
    const data = await source.load();
    decisions = data.decisions || [];
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
    if (wert === 'naechster') {
      state.index = (state.index + 1) % Math.max(1, decisions.length);
      state.scroll = 0;
      await paint();
      return;
    }
    if (wert === 'vertagt') {
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

  async function handleMenu(itemID) {
    const item = menuAction(itemID);
    if (item) await act(item.wert);
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
    if (action?.type === 'activate') {
      const icon = view.icons[action.icon];
      // Der Versand passiert serverseitig nach der Antwort — das Plugin
      // entscheidet nichts selbst und sendet keine Mail.
      await source.answer({ decision: decisions[state.index], wert: icon.wert });
      await refresh();
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
    handleMenu: (itemID) => handleMenu(itemID).catch(onError),
    act: (wert) => act(wert).catch(onError),
    refresh: () => refresh().catch(onError),
    get state() {
      return { ...state, count: decisions.length };
    },
    /** Genau das Ansichtsmodell, das an die Brille geht — fuer den Spiegel. */
    get view() {
      return currentView();
    },
  };
}
