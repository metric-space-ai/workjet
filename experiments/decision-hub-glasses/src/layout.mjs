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
import { renderCaseList, renderLegend, bitmapPayload, ZEILE_FALL } from './icons.mjs';
import { renderDots, renderBar } from './dots.mjs';

// Zeilenhoehe des GERAETEFONTS im Lesekasten. 26 war zu klein gemessen —
// dadurch passte der Inhalt rechnerisch, real aber nicht, und die Brille
// scrollte ihn selbst. Genau das war das Wackeln bei jedem Seitenwechsel.
const LINE_H = 26;          // Listenzeilen links
const TEXT_LINE_H = 34;     // Zeilen im Lesekasten, bewusst grosszuegig
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

export const LEVEL = { RUBRIK: 'rubrik', DETAIL: 'detail' };

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
  if (nav.level === LEVEL.DETAIL) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return pages > 1 ? `${section.titel} ${page + 1}/${pages}` : section.titel;
  }
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
  const seite = bauePage(nav);
  seite.containerTotalNum = (seite.textObject?.length || 0) + (seite.imageObject?.length || 0);
  return seite;
}

function bauePage(nav) {
  const focused = nav.focusIcon >= 0;
  const items = itemLines(nav);
  return {
    // Fest verdrahtet war das schon einmal falsch: die Firmware weist die
    // Seite ab, wenn die angekuendigte Zahl nicht zur tatsaechlichen passt.
    // Wird unten aus den Containern berechnet.
    containerTotalNum: 0,
    textObject: [
      {
        // Eine Box, ein Container: der Rahmen ist Text, damit der Titel in
        // der oberen Kante sitzt. Zugleich der Eingabe-Container — sein
        // Inhalt passt IMMER auf eine Seite, sonst scrollt ihn die Brille
        // selbst und die Gesten erreichen die App nicht mehr.
        containerID: CONTAINER.BOX_BODY,
        containerName: 'box-body',
        xPosition: BOX_X,
        yPosition: BOX_Y,
        width: BOX_W,
        // KONSTANT. Eine inhaltsabhaengige Hoehe waere eine Strukturaenderung
        // und erzwaenge bei jedem Seitenwechsel einen Neuaufbau — sichtbares
        // Neuzeichnen. Gegen das Scrollen hilft isEventCapture, nicht die
        // Hoehe.
        height: BOX_H,
        borderWidth: 1,
        borderColor: focused ? 5 : 13,
        // Schriftgroesse gibt es am Geraet nicht (das SDK kennt kein
        // Schriftfeld). Der einzige Hebel ist die Helligkeit: die
        // Kurzfassung steht voll, der Volltext eine Stufe darunter — man
        // liest die Uebersicht im Vorbeigehen, den Volltext bewusst.
        borderRadius: 10,
        paddingLength: 10,
        content: framedBox(
          boxHeader(nav, PANEL_CHARS),
          contentLines(nav),
          PANEL_CHARS,
          CONTENT_LINES,
        ).join('\n'),
        // Schriftgroesse gibt es am Geraet nicht — das SDK kennt kein
        // Schriftfeld. Der einzige Hebel fuer Gewichtung ist die Helligkeit:
        // die Kurzfassung steht voll, der Volltext eine Stufe darunter. Man
        // ueberfliegt die Uebersicht, den Volltext liest man bewusst.
        textColor: nav.level === LEVEL.DETAIL ? 3 : 4,
        // KEINE Eingaben: ein Eingabecontainer bekommt vom Betriebssystem
        // Scrollverhalten samt Federn — auch dann, wenn gar nichts zu
        // scrollen ist. Genau das war das Wackeln in der Seitenansicht.
        isEventCapture: 0,
        zOrderIndex: 1,
      },
      {
        // Nimmt die Gesten entgegen, damit die App sie bekommt. Leer und
        // winzig: was keinen Inhalt hat, kann nicht scrollen.
        containerID: CONTAINER.BOX_TITLE,
        containerName: 'input',
        xPosition: 0,
        yPosition: DISPLAY_H - 2,
        width: 2,
        height: 2,
        content: '',
        isEventCapture: 1,
        zOrderIndex: 0,
      },
    ],
    imageObject: [
      {
        // Icons UND Namen in einem Bild: nur so laesst sich der aktive
        // Vorgang invertieren, und es spart einen Container.
        containerID: CONTAINER.CHANNELS,
        containerName: 'liste',
        xPosition: COL_X,
        yPosition: LIST_Y,
        width: CH_W + COL_W,
        height: Math.min(144, MAX_ITEMS * ZEILE_FALL),
        zOrderIndex: 3,
      },
      {
        containerID: CONTAINER.DOTS,
        containerName: 'dots',
        xPosition: DOTS_X,
        yPosition: BOX_Y + 8,
        width: DOTS_W,
        height: Math.min(144, BOX_H - 16),
        zOrderIndex: 4,
      },
      {
        // Rubrik-Streifen ueber der oberen Rahmenkante — der Rahmen ist genau
        // dort unterbrochen, wo der Name steht.
        containerID: CONTAINER.LEGEND,
        containerName: 'legend',
        xPosition: BOX_X + 14,
        yPosition: BOX_Y - 10,
        width: LEGEND_W,
        height: 20,
        zOrderIndex: 9,
      },
    ],
    menuObject: {
      menuItems: nav.icons.map((icon, i) => ({ itemID: i + 1, itemName: icon.label || icon.wert })),
    },
  };
}

export function buildBitmaps(nav) {
  const titel = boxTitle(nav);
  const { from, tabs } = visibleCases(nav);
  return [
    bitmapPayload(
      renderCaseList({
        width: CH_W + COL_W,
        height: Math.min(144, MAX_ITEMS * ZEILE_FALL),
        // tabLabel liefert einen String, kein Objekt — das kostete die
        // Namen in der Liste.
        cases: tabs.map((t, i) => ({
          titel: typeof t === 'string' ? t : (t.titel || ''),
          kanal: nav.channels?.[from + i] || (typeof t === 'object' ? t.kanal : null) || 'mail',
        })),
        active: nav.tabIndex - from,
        actions: nav.icons || [],
        focusAction: nav.focusIcon,
        demo: nav.demo,
      }),
      CONTAINER.CHANNELS,
    ),
    bitmapPayload(
      // Uebersicht: ein Punkt je Rubrik. Langfassung: ein durchgehender
      // Balken — man muss auf einen Blick unterscheiden koennen, ob man
      // zwischen Rubriken blaettert oder in einem Text liest.
      (nav.level === LEVEL.DETAIL ? renderBar : renderDots)({
        width: DOTS_W, height: Math.min(144, BOX_H - 16), ...railState(nav),
      }),
      CONTAINER.DOTS,
    ),
    bitmapPayload(
      renderLegend({ title: titel, width: LEGEND_W, height: 20 }),
      CONTAINER.LEGEND,
    ),
  ];
}
