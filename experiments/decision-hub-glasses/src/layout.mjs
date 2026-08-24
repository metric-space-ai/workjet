// Aufbau nach der Dashboard-Vorlage:
//
//   ✉ REM Capital      ·   ┌────────────────────────────────────┐
//   ✉ Thesen AG        ·   │ > MAIL                        12   │
//   ✉ Nordwind         ▌   │   Guten Morgen, seit heute früh…   │
//                      ·   │   ANTWORT-VORSCHLAG            3   │
//                      ·   │   Danke für die Meldung…           │
//   ✓ ✗ ✎ ◷               └────────────────────────────────────┘
//
// Links die anstehenden Entscheidungen mit Kanal-Icon (ohne Rahmen), darunter
// die Icon-Leiste; in der Mitte die Punkte fuer die Seitennavigation; rechts
// die grosse Box mit einer LISTE — wie die Kursliste in der Vorlage, nicht
// als Fliesstext.
//
// Design-Guide: "No background fill", "Selection: Toggle borderWidth",
// "Buttons: Prefix text with '>'".

import { DISPLAY_W, DISPLAY_H } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { pageOf } from '../../kundenpipeline-module/core/sections.mjs';
import { renderActionBar, renderLegend, bitmapPayload } from './icons.mjs';
import { renderDots, renderBar } from './dots.mjs';

// Zeilenhoehe des GERAETEFONTS im Lesekasten. 26 war zu klein gemessen —
// dadurch passte der Inhalt rechnerisch, real aber nicht, und die Brille
// scrollte ihn selbst. Genau das war das Wackeln bei jedem Seitenwechsel.
const LINE_H = 26;          // Listenzeilen links
// Gemessen an gerenderten Seiten: der Geraetefont setzt rund 28px Zeilen.
// Zu grosszuegig gerechnet verschenkt eine ganze Zeile, zu knapp schneidet
// der Kasten den Text ab (er scrollt nicht mehr — er fangt keine Eingaben).
const TEXT_LINE_H = 29;
const CHAR_W = 9.2;

// Linke Spalte
const COL_X = 6;
const CH_W = 20;                        // Spalte der Kanal-Icons
const TEXT_X = COL_X + CH_W + 2;
const COL_W = 150;
const LIST_Y = 8;
// Jeder Vorgang belegt Namenszeile PLUS reservierten Aktionsplatz — der
// Platz gehoert ihm dauerhaft, damit nichts springt, wenn die Aktionen
// erscheinen.
export const MAX_ITEMS = 3;

// Icon-Leiste: sie steht UNTER dem aktiven Eintrag, damit man nach den Icons
// nahtlos auf dem naechsten Eintrag landet.
const BAR_H = 30;
const BAR_W = COL_W + CH_W;
// Feste Streifenbreite: eine mitwachsende Breite waere eine
// Strukturaenderung und erzwaenge bei jeder Rubrik einen Neuaufbau.
const LEGEND_W = 240;

// Punkte fuer die Seitennavigation
const DOTS_X = COL_X + CH_W + COL_W + 2;
// Bildcontainer der Brille muessen mindestens 20 breit sein (SDK: 20~288).
// Mit 8 wies die Firmware die GANZE Seite als invalid zurueck — die App
// startete gar nicht. Der Streifen wird 20 breit, die Punkte darin bleiben
// schmal gezeichnet.
const DOTS_W = 20;

// Lesebox rechts
const BOX_X = DOTS_X + DOTS_W + 4;
// Der Kasten beginnt tiefer, damit der Rubrik-Streifen ueber seiner oberen
// Kante liegen kann, ohne aus dem Display zu laufen.
const BOX_Y = 15;
const BOX_W = DISPLAY_W - BOX_X - 4;
const BOX_H = DISPLAY_H - BOX_Y - 5;

export const CONTAINER = {
  ITEMS: 1,
  BOX_TITLE: 2,
  BOX_BODY: 3,
  CHANNELS: 20,
  DOTS: 21,
  BAR: 22,
  LEGEND: 23,
};

const BRIGHT = 4;
const DIM = 2;

export const LEVEL = { LISTE: 'liste', RUBRIK: 'rubrik', DETAIL: 'detail' };

// Eine Zeile Reserve: passt der Inhalt exakt, scrollt die Brille ihn selbst
// und federt sichtbar zurueck — bei JEDEM Seitenwechsel.
// Wie viele Zeilen der Kasten SICHER traegt, ohne dass die Brille scrollt.
export const CONTENT_LINES = Math.floor((BOX_H - 30) / TEXT_LINE_H);

/**
 * Hoehe des Kastens fuer eine gegebene Zeilenzahl. In der Seitenansicht
 * bekommt er genau die Hoehe seines Inhalts: dann gibt es dort nichts zu
 * scrollen — es gibt in der Seitenansicht keine scrollbare Textbox — und
 * zugleich keine leere Flaeche.
 */
export function boxHeightFor(zeilen) {
  return Math.min(BOX_H, Math.max(60, zeilen * TEXT_LINE_H + 26));
}
export const PANEL_CHARS = Math.floor((BOX_W - 26) / CHAR_W);
// Im Volltext ist der Kasten breiter — der Umbruch muss das wissen, sonst
// bleibt rechts die halbe Zeile leer.
// Der Volltext beginnt links neben dem Leseweg-Balken; rechts endet er
// dort, wo auch die Uebersicht endet.
const DETAIL_BOX_X = 34;
export const DETAIL_CHARS = Math.floor(((BOX_X + BOX_W) - DETAIL_BOX_X - 26) / CHAR_W);
// Zeichen je Zeile inklusive Rahmen.
export const BOX_CHARS = Math.floor(BOX_W / CHAR_W);
const ITEM_CHARS = Math.floor((COL_W - 6) / CHAR_W);

/** Rechtsbuendig auffuellen — das Muster der Werte in der Vorlage. */
function row(left, right, width) {
  // Die Geraetefont ist proportional: eine Zeile, die rechnerisch exakt passt,
  // laeuft real ueber und schneidet rechts ab ("DEMO" wurde zu "DEM").
  // Deshalb zwei Zeichen Reserve.
  const nutz = Math.max(4, width - 5);
  const l = left.slice(0, Math.max(0, nutz - right.length - 1));
  return `${l}${' '.repeat(Math.max(1, nutz - l.length - right.length))}${right}`;
}

/** Sichtbarer Ausschnitt der Entscheidungsliste. */
export function visibleCases(nav) {
  const total = nav.tabs.length;
  if (total <= MAX_ITEMS) return { from: 0, tabs: nav.tabs };
  const from = Math.max(0, Math.min(nav.tabIndex - 1, total - MAX_ITEMS));
  return { from, tabs: nav.tabs.slice(from, from + MAX_ITEMS) };
}

/** Linke Spalte: eine Zeile je anstehender Entscheidung, ohne Rahmen. */
export function itemLines(nav) {
  const { from, tabs } = visibleCases(nav);
  const lines = [];
  tabs.forEach((label, i) => {
    const active = from + i === nav.tabIndex;
    lines.push(`${active ? '>' : ' '}${String(label).slice(0, ITEM_CHARS - 2)}`);
    // Platz fuer die Icon-Leiste direkt unter dem aktiven Eintrag.
    if (active) lines.push('');
  });
  return lines;
}

/** y-Position der Icon-Leiste: direkt unter dem aktiven Eintrag. */
export function barY(nav) {
  const { from, tabs } = visibleCases(nav);
  const rowsBefore = Math.max(0, Math.min(nav.tabIndex - from, tabs.length - 1)) + 1;
  return LIST_Y + rowsBefore * LINE_H + 2;
}

/**
 * Beschriftung des Rahmenstreifens — nur die Rubrik, aufgeklappt mit
 * Seitenzahl. Der Betriebszustand stand hier zuerst mit; bei doppelter
 * Schriftgroesse passt er nicht mehr in die erlaubten 288 Pixel und wurde
 * abgeschnitten. Er gehoert in die linke Spalte, weil er den ganzen Vorgang
 * betrifft und nicht die einzelne Rubrik.
 */
export function boxTitle(nav) {
  if (nav.picker) return nav.picker.titel;
  const section = nav.sections[nav.sectionIndex];
  if (!section) return nav.betreff || '';
  // Keine Seitenzahl: im Volltext liest man durch, die Position zeigt der
  // Balken am rechten Rand. Eine Zaehlung "1/4" macht aus dem Lesen ein
  // Blaettern.
  if (nav.level === LEVEL.DETAIL) return section.titel;
  return section.titel;
}

/**
 * Die Box zeigt IMMER genau eine Seite: in der Uebersicht den Anfang der
 * Rubrik, aufgeklappt die jeweilige Seite ihres Volltexts. Ein Scroll
 * blaettert zur naechsten Rubrik, ein Druck klappt die aktuelle auf.
 */
/**
 * Der Rahmen wird als Text gezeichnet, damit der Rubriktitel IN der oberen
 * Kante sitzt und nicht wie Inhalt aussieht:
 *
 *   ╭─ MAIL ──────────────╮
 *   │ Guten Morgen, …      │
 *   ╰──────────────────────╯
 *
 * Die Rahmenzeichen sind am Simulator als vorhanden geprueft.
 */
/**
 * Kopfzeile der Box: Rubrik links, rechts der Betriebszustand. Im Demo-Modus
 * steht dort DEMO — man muss auf einen Blick sehen, ob eine Entscheidung
 * wirklich etwas ausloest.
 */
export function boxHeader(nav, width) {
  return boxTitle(nav);
}

/**
 * Beschriftung des Rahmenstreifens: nur die Rubrik. Der Betriebszustand
 * stand hier zuerst mit — bei doppelter Schriftgroesse passt er nicht mehr
 * in die erlaubten 288 Pixel und wurde abgeschnitten. Er gehoert in die
 * linke Spalte, weil er den ganzen Vorgang betrifft, nicht die Rubrik.
 */
export function legendTitle(nav) {
  return boxTitle(nav);
}

export function framedBox(title, lines, width, height) {
  // Der Titel steht NICHT mehr im Kasten: er sitzt als Streifen im Rahmen
  // (Container LEGEND). Hier bleibt nur der Inhalt — das gibt zwei Zeilen
  // mehr zurueck, die vorher Titel und Trennstrich belegt haben.
  return lines.slice(0, height);
}

export function framedBoxAlt(title, lines, width, height) {
  // KEIN Textrahmen: die Geraetefont ist proportional, die rechte Kante
  // franst aus (am Simulator gesehen). Den Rahmen zeichnet der Container,
  // hier trennt nur eine Linie den Rubriktitel vom Inhalt — sonst liest sich
  // die Kategorie wie Text.
  // Das Rahmenzeichen ist breiter als ein Durchschnittszeichen; eine Linie
  // ueber die volle Breite bricht um. Eine kurze Linie unter dem Titel
  // trennt ohnehin klarer als ein Strich quer durch die Box.
  const rule = '─'.repeat(Math.max(4, Math.min(16, Math.round(width * 0.35))));
  return [title, rule, ...lines.slice(0, height)];
}

export function contentLines(nav) {
  // Offene Auswahl (z. B. Wiedervorlage) belegt die Box vollstaendig — sie
  // ist eine Frage, keine Nebeninformation.
  if (nav.picker) {
    return nav.picker.options.map((option, i) =>
      `${i === nav.pickerIndex ? '>' : ' '} ${option.label}`,
    ).slice(0, CONTENT_LINES);
  }
  const section = nav.sections[nav.sectionIndex];
  if (!section) return ['Keine Inhalte.'];
  // Laufendes Diktat gehoert vor den Text: es ist ein Zustand, den man
  // sofort sehen muss, sonst spricht man ins Leere.
  const kopf = nav.hinweis ? [nav.hinweis, ''] : [];
  const rest = CONTENT_LINES - kopf.length;
  if (nav.level === LEVEL.DETAIL) {
    return [...kopf, ...pageOf(section, nav.page, rest).zeilen];
  }
  // Uebersicht = eigenstaendige Kurzfassung, nicht der angeschnittene
  // Volltext. Sie soll auf EINE Seite passen; muss sie doch gekuerzt werden,
  // ist das ein Datenfehler und kein Bedienzustand — der Hinweis bleibt.
  const kurz = section.kurz || section.zeilen;
  const lines = kurz.slice(0, rest);
  if (kurz.length > rest) {
    lines[lines.length - 1] = `${(lines[lines.length - 1] || '').slice(0, PANEL_CHARS - 4)} ...`;
  }
  return [...kopf, ...lines];
}

export function railState(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (nav.level === LEVEL.DETAIL && section) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return { count: pages, active: page };
  }
  return { count: Math.max(1, nav.sections.length), active: nav.sectionIndex };
}

export function buildPage(nav) {
  return bauePage(nav);
}

function bauePage(nav) {
  // Drei Ebenen, drei Seiten:
  //   LISTE   OS-Listencontainer der Vorgaenge. Die Brille bewegt den
  //           Auswahlrahmen selbst — nativ animiert, ohne Funkverkehr; das
  //           ist die Dashboard-Anmutung. Kein Bild, kein Catcher: die
  //           Liste ist der Eingabecontainer.
  //   RUBRIK  Karten des offenen Vorgangs; links Fallname und Aktionsleiste.
  //   DETAIL  Volltext ueber die volle Breite, Balken links.
  // Ein offener Picker (Wiedervorlage) nutzt die Rubrik-Seite: dort halten
  // WIR die Gesten, nicht die OS-Liste.
  const ebene = nav.picker ? LEVEL.RUBRIK : nav.level;
  const focused = nav.focusIcon >= 0;

  if (ebene === LEVEL.LISTE) {
    const eintraege = (nav.tabs || []).map((t) => (typeof t === 'string' ? t : t?.titel || ''));
    const status = [
      `${eintraege.length} offene ${eintraege.length === 1 ? 'Entscheidung' : 'Entscheidungen'}`,
      '',
      'Wischen wählt, Drücken öffnet.',
      ...(nav.demo ? ['', 'DEMO — es wird nichts versendet.'] : []),
    ];
    return zaehlen({
      containerTotalNum: 0,
      listObject: [{
        containerID: CONTAINER.CHANNELS,
        containerName: 'fallliste',
        xPosition: COL_X, yPosition: LIST_Y,
        width: 190, height: DISPLAY_H - LIST_Y * 2,
        borderWidth: 0, borderRadius: 8, paddingLength: 4,
        isEventCapture: 1, zOrderIndex: 1,
        itemContainer: {
          itemCount: eintraege.length,
          itemWidth: 176,
          isItemSelectBorderEn: 1,
          itemName: eintraege,
        },
      }],
      textObject: [{
        containerID: CONTAINER.BOX_BODY,
        containerName: 'box-body',
        xPosition: BOX_X, yPosition: BOX_Y,
        width: BOX_W, height: BOX_H,
        borderWidth: 1, borderColor: 13, borderRadius: 10, paddingLength: 10,
        content: status.join('\n'),
        textColor: 3, isEventCapture: 0, zOrderIndex: 2,
      }],
      imageObject: [],
      // KEIN menuObject auf der Listenebene: das Kontextmenue gehoert zum
      // geoeffneten Vorgang, und eine Listen-Seite mit Menue blieb im
      // Simulator bis zur ersten Eingabe schwarz.
    });
  }

  return zaehlen({
    containerTotalNum: 0,
    textObject: [
      {
        // Der Lesekasten. Er waechst im Volltext nach LINKS: rechte Kante,
        // Titelstreifen und rechte Rahmenteile bleiben exakt stehen — beim
        // Aufklappen verschiebt sich nur, was sich verschieben muss.
        containerID: CONTAINER.BOX_BODY,
        containerName: 'box-body',
        xPosition: ebene === LEVEL.DETAIL ? DETAIL_BOX_X : BOX_X,
        yPosition: BOX_Y,
        width: (BOX_X + BOX_W) - (ebene === LEVEL.DETAIL ? DETAIL_BOX_X : BOX_X),
        // KONSTANTE Hoehe: eine inhaltsabhaengige Hoehe waere eine
        // Strukturaenderung und erzwaenge je Seitenwechsel einen Neuaufbau.
        height: BOX_H,
        borderWidth: 1,
        borderColor: focused ? 5 : 13,
        borderRadius: 10,
        paddingLength: 10,
        content: framedBox(boxHeader(nav, PANEL_CHARS), contentLines(nav), PANEL_CHARS, CONTENT_LINES).join('\n'),
        // Kurzfassung voll, Volltext eine Stufe darunter — Helligkeit ist
        // der einzige Gewichtshebel, ein Schriftfeld kennt das SDK nicht.
        textColor: ebene === LEVEL.DETAIL ? 3 : 4,
        // KEINE Eingaben: ein Eingabecontainer bekommt vom OS Scrollverhalten
        // samt Federn, auch ohne Ueberlauf — das war das Wackeln.
        isEventCapture: 0,
        zOrderIndex: 1,
      },
      {
        // Nimmt die Gesten entgegen. Leer und winzig: nichts zu scrollen.
        containerID: CONTAINER.BOX_TITLE,
        containerName: 'input',
        xPosition: 0, yPosition: DISPLAY_H - 2, width: 2, height: 2,
        content: '', isEventCapture: 1, zOrderIndex: 0,
      },
      ...(ebene === LEVEL.RUBRIK ? [{
        // Links steht, WO man ist: der Fallname, darunter ggf. DEMO. Die
        // Vorgangsliste selbst ist auf der Listenebene — hier lenkt sie ab.
        containerID: CONTAINER.ITEMS,
        containerName: 'fall',
        xPosition: COL_X, yPosition: LIST_Y,
        width: CH_W + COL_W, height: 60,
        content: `${nav.betreff || ''}${nav.demo ? '\nDEMO' : ''}`,
        textColor: 2, isEventCapture: 0, zOrderIndex: 3,
      }] : []),
    ],
    imageObject: [
      {
        containerID: CONTAINER.DOTS,
        containerName: 'rail',
        // Rubrik: Punkte zwischen Spalte und Kasten. Volltext: Balken am
        // linken Rand, damit die rechte Rahmenkante stehen bleibt.
        xPosition: ebene === LEVEL.DETAIL ? 8 : DOTS_X,
        yPosition: ebene === LEVEL.DETAIL ? BOX_Y + Math.round((BOX_H - 144) / 2) : BOX_Y + 8,
        width: DOTS_W,
        height: Math.min(144, BOX_H - 16),
        zOrderIndex: 4,
      },
      {
        // Rubrik-Streifen: unterbricht die obere Rahmenkante genau dort,
        // wo der Name steht. Feste Lage in beiden Ansichten.
        containerID: CONTAINER.LEGEND,
        containerName: 'legend',
        xPosition: BOX_X + 14,
        yPosition: BOX_Y - 10,
        width: LEGEND_W, height: 20,
        zOrderIndex: 9,
      },
      ...(ebene === LEVEL.RUBRIK ? [{
        // Aktionsleiste unter dem Fallnamen — fester Platz, nichts springt.
        containerID: CONTAINER.BAR,
        containerName: 'bar',
        xPosition: COL_X, yPosition: LIST_Y + 66,
        width: BAR_W, height: BAR_H,
        zOrderIndex: 5,
      }] : []),
    ],
    menuObject: {
      menuItems: nav.icons.map((icon, i) => ({ itemID: i + 1, itemName: icon.label || icon.wert })),
    },
  });
}

/** Angekuendigte Container-Zahl aus der Wirklichkeit — nie von Hand. */
function zaehlen(page) {
  page.containerTotalNum = (page.listObject?.length || 0)
    + (page.textObject?.length || 0)
    + (page.imageObject?.length || 0);
  return page;
}

export function buildBitmaps(nav) {
  const ebene = nav.picker ? LEVEL.RUBRIK : nav.level;
  // Listenebene: der OS-Container zeichnet alles selbst — null Bilddaten.
  if (ebene === LEVEL.LISTE) return [];

  const titel = boxTitle(nav);
  const bilder = [
    bitmapPayload(
      // Rubrik: ein Punkt je Rubrik. Volltext: durchgehender Balken — man
      // muss sehen, ob man zwischen Rubriken blaettert oder in einem Text
      // liest.
      (ebene === LEVEL.DETAIL ? renderBar : renderDots)({
        width: DOTS_W, height: Math.min(144, BOX_H - 16), ...railState(nav),
      }),
      CONTAINER.DOTS,
    ),
    bitmapPayload(renderLegend({ title: titel, width: LEGEND_W, height: 20 }), CONTAINER.LEGEND),
  ];
  if (ebene === LEVEL.RUBRIK) {
    bilder.push(bitmapPayload(
      renderActionBar({
        icons: nav.icons || [],
        focusIcon: nav.focusIcon,
        width: BAR_W, height: BAR_H,
        detail: nav.detail, compact: true,
      }),
      CONTAINER.BAR,
    ));
  }
  return bilder;
}
