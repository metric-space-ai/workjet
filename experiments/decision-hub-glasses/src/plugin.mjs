// Decision Hub auf der Brille: Entscheidungsvorlage als Rubriken, Seitenleiste
// und gezeichnete Entscheidungs-Icons.
//
// Die Logik liegt in nav.mjs (Bedienung), layout.mjs (Seitenaufbau) und
// sections.mjs (Inhalt) — hier wird nur verdrahtet.

import { decisionIcons, tabLabel, layoutText } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { sectionsOf, pageOf } from '../../kundenpipeline-module/core/sections.mjs';
import { buildPage, buildBitmaps, CONTENT_LINES, PANEL_CHARS, DETAIL_CHARS, LEVEL } from './layout.mjs';
import { navigate, initialNav, caseNav, SNOOZE_OPTIONS, OS_EVENT } from './nav.mjs';
import { createTiltGate } from './tilt.mjs';

// Meldeweg zum Entwicklungsserver; auf der Brille gibt es keine Konsole.
const DEV = Boolean(import.meta.env?.DEV);
const melde = (t) => {
  if (!DEV) return;   // Produktion: kein Beacon, keine Latenz je Geste
  try { console.log('[dh]', String(t)); } catch {}
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
  let letzterText = null;

  /**
   * Fingerabdruck der SEITENSTRUKTUR — Container, Lage, Groesse. Bleibt er
   * gleich, genuegt ein Textaustausch; erst eine echte Strukturaenderung
   * rechtfertigt den flackernden Neuaufbau.
   */
  /** Der gesamte Textinhalt einer Seite — fuer den schnellen Malpfad. */
  function textVon(page) {
    return (page.textObject || []).map((c) => c.content).join('\u0000');
  }

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
    // Volltext bricht auf der breiten Detailspalte um, die Kurzfassung auf
    // der schmalen Uebersicht — sonst passt eine der beiden nie.
    const sections = sectionsOf(d, vorgangOf(d), allowedSections, DETAIL_CHARS).map((sec) => ({
      ...sec,
      kurz: layoutText((sec.kurz || []).join(' '), PANEL_CHARS),
    }));
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
    } else if (signature !== lastSignature
      && strukturVon(page) === letzteStruktur && textVon(page) === letzterText) {
      // Nur Bilder haben sich geaendert (Icon-Fokus, Balkenstand):
      // updateImageRawData zeichnet den Container selbst neu, ein Neuaufbau
      // ist unnoetig — und Neuaufbauten sind das sichtbare Flackern.
    } else if (signature !== lastSignature) {
      // KEIN textContainerUpgrade: das Geraet zeichnet danach nicht neu — im
      // Simulator blieb die Seite beim Blaettern stehen, obwohl der Zustand
      // weiterlief. Ein Neuaufbau ist die einzige Aenderung, die man sieht.
      // Gegen das fruehere Flackern half nicht das Sparen am Neuaufbau,
      // sondern isEventCapture=0 (kein OS-Scrollen) und weniger Bilddaten.

      await mitFrist('rebuildPageContainer', () => sdk.rebuildPageContainer(page));
      // Der Neuaufbau ersetzt die Container — ihre Bildinhalte sind damit
      // weg. Wer jetzt "unveraendert" annimmt, laesst Icons und Punkte
      // verschwinden (am Simulator gesehen: nach dem Aufklappen war die
      // Kanalspalte leer). Also Gedaechtnis loeschen und neu senden.
      gesendeteBilder.clear();
      letzteStruktur = strukturVon(page);
    }
    letzterText = textVon(page);
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
    // Ebene erhalten: nach einer Entscheidung geht es mit dem naechsten
    // Vorgang weiter (Triage-Fluss); nur wer auf der Liste war, bleibt dort.
    nav = nav.level === LEVEL.LISTE ? initialNav() : caseNav();
    await paint();
  }

  /** Einen Vorgang oeffnen — vom OS-Listenklick wie vom Handy. */
  async function openCase(i) {
    if (!decisions.length) return;
    index = Math.max(0, Math.min(i, decisions.length - 1));
    nav = caseNav();
    await paint();
  }

  /**
   * Auswahl aus dem OS-Listencontainer. Die Brille bewegt den Rahmen selbst
   * und meldet erst den Klick; Scroll-Echos (falls das Geraet sie schickt)
   * duerfen nichts ausloesen — ein Neuaufbau wuerde die OS-Auswahl
   * zuruecksetzen.
   */
  async function handleListSelect(sel) {
    melde(`listSelect ${JSON.stringify(sel)}`);
    ruheAnstossen();
    if (!visible) { visible = true; await paint(); return; }
    if (!sel?.klick) return;
    await openCase(sel.index);
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
      nav = caseNav();   // im Triage-Fluss bleiben, nicht auf die Liste
      await paint();
      return;
    }
    await source.answer({ decision: d, wert });
    await refresh();
  }

  async function nextCase() {
    index = (index + 1) % Math.max(1, decisions.length);
    // caseNav, NICHT initialNav: initialNav ist seit dem Umbau die
    // Listenebene, auf der Gesten dem OS-Container gehoeren — wer dort
    // landet, ohne es zu wollen, steht in einer Sackgasse (Test gefangen).
    nav = caseNav();
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
      melde(`Ruhezeit abgelaufen (${ruhezeitMs}ms)`);
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
    if (action?.type === 'zurListe') {
      nav = initialNav();
      await paint();
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
    melde(`IMU-Gate: ${change} nach ${JSON.stringify(sample)}`);
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
      nav = caseNav();
      index = 0;
      await paint();
    },
    select: (i) => openCase(i).catch(onError),
    openCase: (i) => openCase(i).catch(onError),
    handleListSelect: (sel) => handleListSelect(sel).catch(onError),
    snapshot() {
      return { decisions, index, vorgangOf };
    },
    get state() {
      return { ...nav, index, count: decisions.length };
    },
  };
}
