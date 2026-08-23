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
import { renderActionBar, renderChannelColumn, bitmapPayload } from './icons.mjs';
import { renderDots } from './dots.mjs';

const LINE_H = 26;
const CHAR_W = 9.2;

// Linke Spalte
const COL_X = 6;
const CH_W = 20;                        // Spalte der Kanal-Icons
const TEXT_X = COL_X + CH_W + 2;
const COL_W = 150;
const LIST_Y = 8;
export const MAX_ITEMS = 5;

// Icon-Leiste: sie steht UNTER dem aktiven Eintrag, damit man nach den Icons
// nahtlos auf dem naechsten Eintrag landet.
const BAR_H = 30;
const BAR_W = COL_W + CH_W;

// Punkte fuer die Seitennavigation
const DOTS_X = COL_X + CH_W + COL_W + 2;
// Bildcontainer der Brille muessen mindestens 20 breit sein (SDK: 20~288).
// Mit 8 wies die Firmware die GANZE Seite als invalid zurueck — die App
// startete gar nicht. Der Streifen wird 20 breit, die Punkte darin bleiben
// schmal gezeichnet.
const DOTS_W = 20;

// Lesebox rechts
const BOX_X = DOTS_X + DOTS_W + 4;
const BOX_Y = 4;
const BOX_W = DISPLAY_W - BOX_X - 4;
const BOX_H = DISPLAY_H - BOX_Y * 2;

export const CONTAINER = {
  ITEMS: 1,
  BOX_TITLE: 2,
  BOX_BODY: 3,
  CHANNELS: 20,
  DOTS: 21,
  BAR: 22,
};

const BRIGHT = 4;
const DIM = 2;

export const LEVEL = { RUBRIK: 'rubrik', DETAIL: 'detail' };

export const CONTENT_LINES = Math.floor((BOX_H - 20) / LINE_H) - 2;
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

export function boxTitle(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (nav.picker) return row(nav.picker.titel, nav.demo ? 'DEMO' : '', PANEL_CHARS);
  // Oben rechts steht immer, woran man ist: im Demo-Modus DEMO, sonst der
  // Vorgang. Ohne diesen Hinweis waere am Geraet nicht zu erkennen, ob eine
  // Entscheidung wirklich etwas ausloest.
  const rechts = nav.demo ? 'DEMO' : (nav.typ || '');
  if (nav.level === LEVEL.DETAIL && section) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    const links = pages > 1 ? `${section.titel} ${page + 1}/${pages}` : section.titel;
    return row(links, rechts, PANEL_CHARS);
  }
  return row(section ? section.titel : (nav.betreff || ''), rechts, PANEL_CHARS);
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
  const links = boxTitle(nav);
  const rechts = nav.demo ? 'DEMO' : (nav.typ || '');
  if (!rechts) return links;
  return row(links, rechts, width);
}

export function framedBox(title, lines, width, height) {
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
  const lines = section.zeilen.slice(0, rest);
  if (section.zeilen.length > rest) {
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
  const focused = nav.focusIcon >= 0;
  const items = itemLines(nav);
  return {
    containerTotalNum: 5,
    textObject: [
      {
        containerID: CONTAINER.ITEMS,
        containerName: 'items',
        xPosition: TEXT_X,
        yPosition: LIST_Y,
        width: COL_W,
        height: Math.min(items.length, MAX_ITEMS) * LINE_H + 6,
        content: items.join('\n'),
        textColor: focused ? DIM : BRIGHT,
        isEventCapture: 0,
        zOrderIndex: 0,
      },
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
        height: BOX_H,
        borderWidth: 1,
        borderColor: focused ? 5 : 13,
        borderRadius: 10,
        paddingLength: 10,
        content: framedBox(
          boxHeader(nav, PANEL_CHARS),
          contentLines(nav),
          PANEL_CHARS,
          CONTENT_LINES,
        ).join('\n'),
        textColor: focused ? DIM : BRIGHT,
        isEventCapture: 1,
        zOrderIndex: 1,
      },
    ],
    imageObject: [
      {
        containerID: CONTAINER.CHANNELS,
        containerName: 'channels',
        xPosition: COL_X,
        yPosition: LIST_Y,
        width: CH_W,
        height: Math.min(144, (MAX_ITEMS + 1) * LINE_H),
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
        containerID: CONTAINER.BAR,
        containerName: 'bar',
        xPosition: COL_X,
        yPosition: barY(nav),
        width: BAR_W,
        height: BAR_H,
        zOrderIndex: 5,
      },
    ],
    menuObject: {
      menuItems: nav.icons.map((icon, i) => ({ itemID: i + 1, itemName: icon.label || icon.wert })),
    },
  };
}

export function buildBitmaps(nav) {
  const { from, tabs } = visibleCases(nav);
  return [
    bitmapPayload(
      renderChannelColumn({
        width: CH_W,
        height: Math.min(144, (MAX_ITEMS + 1) * LINE_H),
        pitch: LINE_H,
        channels: tabs.map((_, i) => nav.channels?.[from + i] || 'mail'),
        active: nav.tabIndex - from,
        // Zeilenindex je Eintrag: nach dem aktiven schiebt die Icon-Leiste
        // alles um eine Zeile nach unten.
        rows: tabs.map((_, i) => i + (from + i > nav.tabIndex ? 1 : 0)),
      }),
      CONTAINER.CHANNELS,
    ),
    bitmapPayload(
      renderDots({ width: DOTS_W, height: Math.min(144, BOX_H - 16), ...railState(nav) }),
      CONTAINER.DOTS,
    ),
    bitmapPayload(
      renderActionBar({
        icons: nav.icons,
        focusIcon: nav.focusIcon,
        width: BAR_W,
        height: BAR_H,
        detail: nav.detail,
        compact: true,
      }),
      CONTAINER.BAR,
    ),
  ];
}
