// Seitenaufbau nach der Layout-Strategie des Owners (Skizze auf dem
// Geraete-Dashboard):
//
//   ┌────────────┐  ┌──────────────────────────────────────┐
//   │ Item MAIL  │  │ MAIL                                 │
//   ├────────────┤  │ Guten Morgen, seit heute früh meldet │
//   │ Item ANTW. │  │ unser Portal beim Login einen CORS-  │
//   ├────────────┤  │ Fehler …                             │
//   │ Item AUFG. │  │                                      │
//   ├────────────┤  │                                      │
//   │ Item AUDIT │  │                                      │
//   └────────────┘  │                                      │
//   ✓  ✗  ✎  ◷     └──────────────────────────────────────┘
//
// Links die Rubriken als Items und darunter die Icon-Leiste, rechts die
// grosse Lesebox. Auswahl per Rahmen (Design-Guide: "Selection: Toggle
// borderWidth on text containers"), keine gefuellten Flaechen.

import { DISPLAY_W, DISPLAY_H } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { pageOf } from '../../kundenpipeline-module/core/sections.mjs';
import { renderActionBar, bitmapPayload } from './icons.mjs';
import { renderDots } from './dots.mjs';

const LINE_H = 26;
const CHAR_W = 9.2;

// Linke Spalte
const COL_X = 6;
const COL_W = 150;
const ITEM_H = 30;
const ITEM_GAP = 4;
const ITEMS_Y = 10;
const MAX_ITEMS = 4;

// Icon-Leiste unten links
const BAR_H = 40;
const BAR_Y = DISPLAY_H - BAR_H - 8;

// Navigationspunkte zwischen Spalte und Box — wie im Geraete-Dashboard.
const DOTS_X = COL_X + COL_W + 4;
const DOTS_W = 10;

// Lesebox rechts: so gross wie moeglich, sie traegt den Inhalt.
const BOX_X = DOTS_X + DOTS_W + 4;
const BOX_Y = 4;
const BOX_W = DISPLAY_W - BOX_X - 4;
const BOX_H = DISPLAY_H - BOX_Y * 2;

export const CONTAINER = {
  BOX_TITLE: 1,
  BOX_BODY: 2,
  ITEM_BASE: 3,      // 3..6
  BAR: 20,
  DOTS: 21,
};

const BRIGHT = 4;
const DIM = 2;

export const LEVEL = { RUBRIK: 'rubrik', DETAIL: 'detail' };

export const CONTENT_LINES = Math.floor((BOX_H - 22) / LINE_H) - 1;
export const PANEL_CHARS = Math.floor((BOX_W - 26) / CHAR_W);
const ITEM_CHARS = Math.floor((COL_W - 18) / CHAR_W);

export function titleLine(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (!section) return '';
  if (nav.level === LEVEL.DETAIL) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return pages > 1 ? `${section.titel}  ${page + 1}/${pages}` : section.titel;
  }
  return section.zeilen.length > CONTENT_LINES ? `${section.titel}  ...` : section.titel;
}

export function contentLines(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (!section) return ['Keine Inhalte.'];
  return nav.level === LEVEL.DETAIL
    ? pageOf(section, nav.page, CONTENT_LINES).zeilen
    : section.zeilen.slice(0, CONTENT_LINES);
}

/** Sichtbarer Ausschnitt der Item-Liste — sie scrollt mit der Auswahl mit. */
export function visibleItems(nav) {
  const total = nav.sections.length;
  if (total <= MAX_ITEMS) return { from: 0, items: nav.sections };
  const from = Math.max(0, Math.min(nav.sectionIndex - 1, total - MAX_ITEMS));
  return { from, items: nav.sections.slice(from, from + MAX_ITEMS) };
}

export function itemLabel(section, active) {
  const text = section.titel.length > ITEM_CHARS - 2
    ? `${section.titel.slice(0, ITEM_CHARS - 3)}.`
    : section.titel;
  return active ? `> ${text}` : `  ${text}`;
}

export function railState(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (nav.level === LEVEL.DETAIL && section) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return { count: pages, active: page };
  }
  return { count: nav.sections.length, active: nav.sectionIndex };
}

export function buildPage(nav) {
  const focused = nav.focusIcon >= 0;
  const { from, items } = visibleItems(nav);

  const itemContainers = items.map((section, i) => {
    const index = from + i;
    const active = index === nav.sectionIndex && !focused;
    return {
      containerID: CONTAINER.ITEM_BASE + i,
      containerName: `item-${index}`,
      xPosition: COL_X,
      yPosition: ITEMS_Y + i * (ITEM_H + ITEM_GAP),
      width: COL_W,
      height: ITEM_H,
      content: itemLabel(section, active),
      textColor: active ? BRIGHT : DIM,
      borderWidth: active ? 2 : 1,
      borderColor: active ? 14 : 5,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 0,
      zOrderIndex: 10 + i,
    };
  });

  return {
    containerTotalNum: 2 + itemContainers.length,
    textObject: [
      {
        // Die Lesebox — Rahmen ist die Struktur, der Titel die erste Zeile.
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
        // Eingabe-Container: Inhalt passt IMMER auf eine Seite, sonst scrollt
        // die Brille ihn selbst und die Gesten erreichen die App nicht.
        containerID: CONTAINER.BOX_BODY,
        containerName: 'box-body',
        xPosition: BOX_X + 12,
        yPosition: BOX_Y + LINE_H + 12,
        width: BOX_W - 24,
        height: BOX_H - LINE_H - 24,
        content: contentLines(nav).join('\n'),
        textColor: focused ? DIM : BRIGHT,
        isEventCapture: 1,
        zOrderIndex: 2,
      },
      ...itemContainers,
    ],
    imageObject: [
      {
        containerID: CONTAINER.DOTS,
        containerName: 'dots',
        xPosition: DOTS_X,
        yPosition: BOX_Y + 6,
        width: DOTS_W,
        height: Math.min(144, BOX_H - 12),
        zOrderIndex: 4,
      },
      {
        containerID: CONTAINER.BAR,
        containerName: 'bar',
        xPosition: COL_X,
        yPosition: BAR_Y,
        width: COL_W,
        height: BAR_H,
        zOrderIndex: 3,
      },
    ],
    menuObject: {
      menuItems: nav.icons.map((icon, i) => ({ itemID: i + 1, itemName: icon.label || icon.wert })),
    },
  };
}

export function buildBitmaps(nav) {
  return [
    bitmapPayload(
      renderDots({ width: DOTS_W, height: Math.min(144, BOX_H - 12), ...railState(nav) }),
      CONTAINER.DOTS,
    ),
    bitmapPayload(
      renderActionBar({
        icons: nav.icons,
        focusIcon: nav.focusIcon,
        width: COL_W,
        height: BAR_H,
        detail: nav.detail,
        compact: true,
      }),
      CONTAINER.BAR,
    ),
  ];
}
