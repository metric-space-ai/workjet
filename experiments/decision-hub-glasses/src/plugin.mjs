// Decision Hub auf der Brille: Entscheidungsvorlage als Rubriken, Seitenleiste
// und gezeichnete Entscheidungs-Icons.
//
// Die Logik liegt in nav.mjs (Bedienung), layout.mjs (Seitenaufbau) und
// sections.mjs (Inhalt) — hier wird nur verdrahtet.

import { decisionIcons, tabLabel } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { sectionsOf, pageOf } from '../../kundenpipeline-module/core/sections.mjs';
import { buildPage, buildBitmaps, CONTENT_LINES, PANEL_CHARS, LEVEL } from './layout.mjs';
import { navigate, initialNav } from './nav.mjs';

export function createDecisionHubPlugin({
  sdk,
  source,
  onError = () => {},
  onPaint = () => {},
  filter = () => true,
  sections: allowedSections = ['mail', 'antwort', 'aufgabe', 'notizen'],
}) {
  let decisions = [];
  let vorgaenge = new Map();
  let index = 0;
  let nav = initialNav();
  let started = false;
  let lastSignature = null;

  const decision = () => decisions[index];
  const vorgangOf = (d) => vorgaenge.get(d?.vorgang_id);

  function currentNav() {
    const d = decision();
    if (!d) return null;
    const sections = sectionsOf(d, vorgangOf(d), allowedSections, PANEL_CHARS);
    return {
      ...nav,
      tabs: decisions.map((item) => tabLabel(item, vorgangOf(item))),
      tabIndex: index,
      sections,
      icons: decisionIcons(d, {}, nav.level === LEVEL.DETAIL ? 1 : 0),
      detail: nav.level === LEVEL.DETAIL ? 1 : 0,
      typ: (d.typ || '').toUpperCase(),
    };
  }

  function dimsOf(view) {
    const section = view.sections[view.sectionIndex];
    return {
      sections: view.sections.length,
      pages: section ? pageOf(section, view.page, CONTENT_LINES).pages : 1,
      icons: view.icons.length,
    };
  }

  async function paint() {
    const view = currentNav();
    onPaint(view);
    if (!view) return;
    // Der Seitenaufbau aendert sich mit Ebene, Rubrik und Fokus; nur dann muss
    // neu gebaut werden. Bilder tragen Auswahl und Position, also gehen sie
    // bei jeder Aenderung mit.
    const signature = `${index}|${view.level}|${view.sectionIndex}|${view.page}|${view.focusIcon}`;
    if (!started) {
      const result = await sdk.createStartUpPageContainer(buildPage(view));
      if (result !== 0 && result?.code !== 0) {
        throw new Error(`createStartUpPageContainer failed: ${JSON.stringify(result)}`);
      }
      started = true;
    } else if (signature !== lastSignature) {
      await sdk.rebuildPageContainer(buildPage(view));
    }
    if (signature !== lastSignature) {
      for (const payload of buildBitmaps(view)) await sdk.updateImageRawData(payload);
      lastSignature = signature;
    }
  }

  async function refresh() {
    const data = await source.load();
    decisions = (data.decisions || []).filter(filter);
    vorgaenge = new Map((data.vorgaenge || []).map((v) => [v.id, v]));
    if (index >= decisions.length) index = 0;
    nav = initialNav();
    await paint();
  }

  /** Eine Entscheidung ausfuehren — von der Brille wie vom Handy. */
  async function act(wert) {
    const d = decision();
    if (!d) return;
    if (wert === 'detail') {
      nav = { ...nav, level: nav.level === LEVEL.DETAIL ? LEVEL.RUBRIK : LEVEL.DETAIL, page: 0, focusIcon: -1 };
      await paint();
      return;
    }
    if (wert === 'vertagt') {
      decisions.push(decisions.splice(index, 1)[0]);
      index = Math.min(index, Math.max(0, decisions.length - 1));
      nav = initialNav();
      await paint();
      return;
    }
    await source.answer({ decision: d, wert });
    await refresh();
  }

  async function nextCase() {
    index = (index + 1) % Math.max(1, decisions.length);
    nav = initialNav();
    await paint();
  }

  async function handleEvent(osEvent) {
    const view = currentNav();
    if (!view) return;
    const { nav: nextNav, action } = navigate(nav, osEvent, dimsOf(view));
    nav = nextNav;
    if (action?.type === 'activate') {
      const icon = view.icons[action.icon];
      if (icon?.wert) await act(icon.wert);
      return;
    }
    if (action?.type === 'nextCase') {
      await nextCase();
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
    async showTestCard() {
      decisions = [{
        id: 'testkarte', vorgang_id: 'testkarte', typ: 'zuordnung', titel: 'Testkarte',
        status: 'offen', zeilen_json: ['Wenn du das liest, trägt die Kette.'],
      }];
      vorgaenge = new Map([['testkarte', {
        id: 'testkarte', kunde_name: 'Test',
        quelle_json: { body_clean: `Testkarte gesendet um ${new Date().toLocaleTimeString('de-DE')}.` },
      }]]);
      index = 0;
      nav = initialNav();
      await paint();
    },
    async select(i) {
      index = i;
      nav = initialNav();
      await paint();
    },
    snapshot() {
      return { decisions, index, vorgangOf };
    },
    get state() {
      return { ...nav, index, count: decisions.length };
    },
  };
}
