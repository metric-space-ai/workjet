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

// Icon-Leiste unten links
const BAR_H = 40;
const BAR_W = COL_W + CH_W;
const BAR_Y = DISPLAY_H - BAR_H - 6;

// Punkte fuer die Seitennavigation
const DOTS_X = COL_X + CH_W + COL_W + 2;
const DOTS_W = 8;

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

export const CONTENT_LINES = Math.floor((BOX_H - 24) / LINE_H) - 1;
export const PANEL_CHARS = Math.floor((BOX_W - 26) / CHAR_W);
const ITEM_CHARS = Math.floor((COL_W - 6) / CHAR_W);

/** Rechtsbuendig auffuellen — das Muster der Werte in der Vorlage. */
function row(left, right, width) {
  const l = left.slice(0, Math.max(0, width - right.length - 1));
  return `${l}${' '.repeat(Math.max(1, width - l.length - right.length))}${right}`;
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
  return tabs.map((label, i) => {
    const active = from + i === nav.tabIndex;
    const text = String(label).slice(0, ITEM_CHARS - 2);
    return `${active ? '>' : ' '}${text}`;
  });
}

export function titleLine(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (nav.level === LEVEL.DETAIL && section) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return pages > 1
      ? row(section.titel, `${page + 1}/${pages}`, PANEL_CHARS)
      : section.titel;
  }
  return row(nav.betreff || 'ENTSCHEIDUNGSVORLAGE', nav.typ || '', PANEL_CHARS);
}

export function contentLines(nav) {
  if (!nav.sections.length) return ['Keine Inhalte.'];
  if (nav.level === LEVEL.DETAIL) {
    return pageOf(nav.sections[nav.sectionIndex], nav.page, CONTENT_LINES).zeilen;
  }
  // Uebersicht als Liste: Rubrik mit Umfang, darunter die Vorschau.
  const out = [];
  nav.sections.forEach((section, i) => {
    if (out.length >= CONTENT_LINES) return;
    const active = i === nav.sectionIndex && nav.focusIcon < 0;
    out.push(row(`${active ? '>' : ' '} ${section.titel}`, `${section.zeilen.length}`, PANEL_CHARS));
    const vorschau = (section.vorschau || '').trim();
    if (vorschau && out.length < CONTENT_LINES) {
      out.push(`   ${vorschau}`.slice(0, PANEL_CHARS));
    }
  });
  return out.slice(0, CONTENT_LINES);
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
    containerTotalNum: 6,
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
        // Die Box — Rahmen ist die einzige Struktur, die der Guide vorsieht.
        containerID: CONTAINER.BOX_TITLE,
        containerName: 'box-title',
        xPosition: BOX_X,
        yPosition: BOX_Y,
        width: BOX_W,
        height: BOX_H,
        content: titleLine(nav),
        textColor: focused ? DIM : BRIGHT,
        borderWidth: 1,
        borderColor: focused ? 5 : 13,
        borderRadius: 10,
        paddingLength: 10,
        isEventCapture: 0,
        zOrderIndex: 1,
      },
      {
        // Eingabe-Container: passt IMMER auf eine Seite, sonst scrollt die
        // Brille ihn selbst und die Gesten erreichen die App nicht mehr.
        containerID: CONTAINER.BOX_BODY,
        containerName: 'box-body',
        xPosition: BOX_X + 12,
        yPosition: BOX_Y + LINE_H + 10,
        width: BOX_W - 24,
        height: BOX_H - LINE_H - 22,
        content: contentLines(nav).join('\n'),
        textColor: focused ? DIM : BRIGHT,
        isEventCapture: 1,
        zOrderIndex: 2,
      },
    ],
    imageObject: [
      {
        containerID: CONTAINER.CHANNELS,
        containerName: 'channels',
        xPosition: COL_X,
        yPosition: LIST_Y,
        width: CH_W,
        height: Math.min(144, MAX_ITEMS * LINE_H),
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
        yPosition: BAR_Y,
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
        height: Math.min(144, MAX_ITEMS * LINE_H),
        pitch: LINE_H,
        channels: tabs.map((_, i) => nav.channels?.[from + i] || 'mail'),
        active: nav.tabIndex - from,
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
