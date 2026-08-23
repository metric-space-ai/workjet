// Decision Hub auf der Brille: Entscheidungsvorlage als Rubriken, Seitenleiste
// und gezeichnete Entscheidungs-Icons.
//
// Die Logik liegt in nav.mjs (Bedienung), layout.mjs (Seitenaufbau) und
// sections.mjs (Inhalt) — hier wird nur verdrahtet.

import { decisionIcons, tabLabel } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { sectionsOf, pageOf } from '../../kundenpipeline-module/core/sections.mjs';
import { buildPage, buildBitmaps, CONTENT_LINES, PANEL_CHARS, LEVEL } from './layout.mjs';
import { navigate, initialNav, SNOOZE_OPTIONS, OS_EVENT } from './nav.mjs';
import { createTiltGate } from './tilt.mjs';

// Meldeweg zum Entwicklungsserver; auf der Brille gibt es keine Konsole.
const melde = (t) => {
  try { fetch(`${location.origin}/__log`, { method: 'POST', body: String(t) }).catch(() => {}); } catch {}
};

/**
 * Ein Brueckenaufruf, der nicht antwortet, friert die App lautlos ein — genau
 * so blieb der Start haengen. Deshalb bekommt jeder Aufruf eine Frist.
 */
async function mitFrist(name, aufruf, ms = 8000) {
  melde(`-> ${name}`);
  let timer;
  const frist = new Promise((_, ab) => { timer = setTimeout(() => ab(new Error(`${name} antwortet seit ${ms}ms nicht`)), ms); });
  try {
    const wert = await Promise.race([aufruf(), frist]);
    melde(`<- ${name} = ${JSON.stringify(wert)}`);
    return wert;
  } catch (fehler) {
    melde(`!! ${name}: ${fehler.message}`);
    throw fehler;
  } finally {
    clearTimeout(timer);
  }
}

export function createDecisionHubPlugin({
  sdk,
  source,
  demo = false,
  // Eine Wischbewegung auf dem Buegel loest mehrere Scroll-Ereignisse aus.
  // Ohne Sperrzeit rauscht die Anzeige durch mehrere Seiten und ist auf der
  // echten Brille nicht bedienbar. Wert in Millisekunden.
  scrollSperreMs = 320,
  // Nach dieser Ruhezeit blendet die Anzeige aus. 0 schaltet das ab.
  ruhezeitMs = 45000,
  jetzt = () => Date.now(),
  onError = () => {},
  onPaint = () => {},
  filter = () => true,
  sections: allowedSections = ['mail', 'antwort', 'aufgabe', 'notizen'],
  tiltOptions = {},
}) {
  let decisions = [];
  let vorgaenge = new Map();
  let index = 0;
  let nav = initialNav();
  let started = false;
  let lastSignature = null;
  let visible = true;
  let diktat = null;   // { seit, frames } solange das Mikrofon laeuft
  const gesendeteBilder = new Map();  // containerID -> Fingerabdruck
  let letzteStruktur = null;

  /**
   * Fingerabdruck der SEITENSTRUKTUR — Container, Lage, Groesse. Bleibt er
   * gleich, genuegt ein Textaustausch; erst eine echte Strukturaenderung
   * rechtfertigt den flackernden Neuaufbau.
   */
  function strukturVon(page) {
    return [...(page.textObject || []), ...(page.imageObject || [])]
      .map((c) => `${c.containerID}:${c.xPosition},${c.yPosition},${c.width},${c.height}`)
      .join('|');
  }
  const tilt = createTiltGate(tiltOptions);

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
      demo,
      hinweis: nav.hinweis || null,
      diktat: Boolean(diktat),
      betreff: vorgangOf(d)?.title || d.titel || '',
      // Kanal je Eintrag: bestimmt das Icon links vor dem Text.
      channels: decisions.map((item) => {
        const kanal = vorgaenge.get(item.vorgang_id)?.quelle_json?.kanal;
        return kanal === 'chat' ? 'chat' : kanal === 'dokument' ? 'doc' : 'mail';
      }),
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
    const signature = visible
      // Die Auswahlliste MUSS in die Signatur: sonst aendert sich der Zustand,
      // aber der Schirm bleibt stehen (genau so verschwand die Wiedervorlage).
      ? `${index}|${view.level}|${view.sectionIndex}|${view.page}|${view.focusIcon}|${view.picker?.kind || ''}|${view.pickerIndex ?? ''}|${view.hinweis || ''}`
      : 'hidden';
    const page = visible ? buildPage(view) : blankPage();
    if (!started) {
      const result = await mitFrist('createStartUpPageContainer', () => sdk.createStartUpPageContainer(page));
      if (result !== 0 && result?.code !== 0) {
        throw new Error(`createStartUpPageContainer failed: ${JSON.stringify(result)}`);
      }
      started = true;
      letzteStruktur = strukturVon(page);
    } else if (signature !== lastSignature && strukturVon(page) === letzteStruktur) {
      // Gleiche Struktur, anderer Inhalt: NUR den Text tauschen. Ein voller
      // Neuaufbau baut die Seite bei jedem Scroll sichtbar neu auf — am
      // Geraet als unbedienbar gemeldet.
      for (const c of page.textObject || []) {
        await mitFrist('textContainerUpgrade', () => sdk.textContainerUpgrade({
          containerID: c.containerID,
          containerName: c.containerName,
          content: c.content,
        }));
      }
    } else if (signature !== lastSignature) {
      await mitFrist('rebuildPageContainer', () => sdk.rebuildPageContainer(page));
      // Der Neuaufbau ersetzt die Container — ihre Bildinhalte sind damit
      // weg. Wer jetzt "unveraendert" annimmt, laesst Icons und Punkte
      // verschwinden (am Simulator gesehen: nach dem Aufklappen war die
      // Kanalspalte leer). Also Gedaechtnis loeschen und neu senden.
      gesendeteBilder.clear();
      letzteStruktur = strukturVon(page);
    }
    if (signature !== lastSignature) {
      // Ausgeblendet gibt es nichts zu zeichnen — das spart Funk und Strom.
      if (visible) {
        for (const payload of buildBitmaps(view)) {
          // Nur senden, was sich wirklich geaendert hat. Alles bei jedem
          // Schritt neu zu funken ueberlastet die Strecke und quittiert mit
          // sendFailed — dann fehlen Icons und Punkte ganz.
          const abdruck = payload.fingerprint;
          if (abdruck && gesendeteBilder.get(payload.containerID) === abdruck) continue;
          const ergebnis = await mitFrist('updateImageRawData', () =>
            sdk.updateImageRawData({ containerID: payload.containerID, imageData: payload.imageData }));
          if (ergebnis === 0 || ergebnis === 'success') gesendeteBilder.set(payload.containerID, abdruck);
          else gesendeteBilder.delete(payload.containerID);
        }
      }
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
    if (wert === 'korrektur') {
      // Korrektur wird diktiert: Mikrofon der Brille an, zweiter Druck
      // beendet. Die Umwandlung in Text passiert serverseitig — das Plugin
      // sammelt nur die Aufnahme und behauptet nichts anderes.
      if (diktat) {
        await sdk.audioControl?.(false);
        const dauer = Math.round((Date.now() - diktat.seit) / 1000);
        diktat = null;
        nav = { ...nav, hinweis: `Diktat aufgenommen (${dauer}s)` };
        await paint();
        return;
      }
      const ok = await sdk.audioControl?.(true, 'glasses');
      if (ok === false) {
        nav = { ...nav, hinweis: 'Mikrofon nicht verfügbar' };
      } else {
        diktat = { seit: Date.now(), frames: 0 };
        nav = { ...nav, hinweis: 'Diktat läuft — Druck beendet' };
      }
      await paint();
      return;
    }
    if (wert === 'detail') {
      nav = { ...nav, level: nav.level === LEVEL.DETAIL ? LEVEL.RUBRIK : LEVEL.DETAIL, page: 0, focusIcon: -1 };
      await paint();
      return;
    }
    if (wert === 'vertagt') {
      // Die Uhr fragt zuerst, wie lange vertagt werden soll.
      nav = {
        ...nav,
        picker: { kind: 'snooze', titel: 'WIEDERVORLAGE', options: SNOOZE_OPTIONS },
        pickerIndex: 0,
        focusIcon: -1,
      };
      await paint();
      return;
    }
    if (wert === '__vertagt_bestaetigt') {
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

  let letzterScroll = 0;
  let ruheUhr = null;

  /** Ruhezeit neu anstossen — nach jeder Bedienung. */
  function ruheAnstossen() {
    if (ruheUhr) clearTimeout(ruheUhr);
    ruheUhr = null;
    if (!ruhezeitMs || !visible) return;
    ruheUhr = setTimeout(() => {
      // Die Brille traegt man den ganzen Tag; eine liegengebliebene Anzeige
      // im Blickfeld stoert. Sie kommt beim naechsten Handgriff zurueck.
      visible = false;
      paint().catch(() => {});
    }, ruhezeitMs);
    if (typeof ruheUhr?.unref === 'function') ruheUhr.unref();
  }

  async function handleEvent(osEvent) {
    const view = currentNav();
    if (!view) return;
    ruheAnstossen();
    if (!visible) {
      // Ausgeblendet: der erste Handgriff holt die Anzeige zurueck und
      // fuehrt sonst nichts aus — sonst entscheidet man blind.
      visible = true;
      await paint();
      return;
    }
    if (osEvent === OS_EVENT.SCROLL_TOP || osEvent === OS_EVENT.SCROLL_BOTTOM) {
      const jetzt = Date.now();
      if (jetzt - letzterScroll < scrollSperreMs) return;   // Nachzuegler derselben Geste
      letzterScroll = jetzt;
    }
    const { nav: nextNav, action } = navigate(nav, osEvent, dimsOf(view));
    nav = nextNav;
    if (action?.type === 'activate') {
      const icon = view.icons[action.icon];
      if (icon?.wert) await act(icon.wert);
      return;
    }
    if (action?.type === 'pick') {
      if (action.kind === 'snooze') {
        // Der Vorgang bleibt offen und wandert ans Ende — mit der gewaehlten
        // Frist, damit die Wiedervorlage nachvollziehbar ist.
        const d = decision();
        if (d) d.wiedervorlage_ms = Date.now() + action.option.minutes * 60000;
        await act('__vertagt_bestaetigt');
      }
      return;
    }
    if (action?.type === 'nextCase') {
      await nextCase();
      return;
    }
    if (action?.type === 'prevCase' && index === 0) {
      // Ganz oben angekommen: statt im Kreis zum letzten Vorgang zu springen,
      // blendet die Anzeige aus. Das ist die Geste zum Wegschauen — der
      // naechste Handgriff holt sie zurueck.
      visible = false;
      await paint();
      return;
    }
    if (action?.type === 'prevCase') {
      // Beim Rueckwaertsgehen landet man auf den Icons des vorherigen
      // Vorgangs — dort, wo man ihn nach unten verlassen haette.
      index = (index - 1 + Math.max(1, decisions.length)) % Math.max(1, decisions.length);
      const view = currentNav();
      nav = {
        ...nav,
        sectionIndex: Math.max(0, (view?.sections.length || 1) - 1),
        page: 0,
        focusIcon: (view?.icons.length || 1) - 1,
      };
      await paint();
      return;
    }
    await paint();
  }

  /** Ausgeblendet: eine leere Seite, die App laeuft weiter. */
  function blankPage() {
    return {
      containerTotalNum: 1,
      textObject: [{
        containerID: 1,
        containerName: 'blank',
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        content: '',
        textColor: 0,
        isEventCapture: 1,
        zOrderIndex: 0,
      }],
    };
  }

  /** IMU-Daten der Brille: Kopf in den Nacken blendet ein und aus. */
  async function handleImu(sample) {
    const change = tilt.feed(sample);
    if (!change) return;
    visible = change === 'show';
    await paint();
  }

  return {
    async start() {
      try {
        await refresh();
        ruheAnstossen();
      } catch (error) {
        onError(error);
        throw error;
      }
    },
    /** Ruhezeit anhalten — fuer Tests und beim Beenden. */
    stop() {
      if (ruheUhr) clearTimeout(ruheUhr);
      ruheUhr = null;
    },
    handleEvent: (osEvent) => handleEvent(osEvent).catch(onError),
    handleImu: (sample) => handleImu(sample).catch(onError),
    get visible() {
      return visible;
    },
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
