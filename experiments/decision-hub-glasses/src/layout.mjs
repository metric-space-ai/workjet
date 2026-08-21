// Seitenaufbau der Entscheidungsvorlage — an der Gestaltung des Geraete-
// Dashboards ausgerichtet: links eine schmale Statusspalte, rechts ein
// gerahmtes Panel mit dem Inhalt, dazwischen eine gepunktete Positionsleiste,
// unten die Entscheidungs-Icons.
//
//   REM Capital        ·   ┌─────────────────────────────┐
//   TRIAGE             ·   │ MAIL                        │
//   2/5                ▌   │ Guten Morgen, seit heute …  │
//                      ·   │                             │
//                      ·   └─────────────────────────────┘
//   ✓    ✗    ✎    ◷

import { DISPLAY_W, DISPLAY_H } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { pageOf } from '../../kundenpipeline-module/core/sections.mjs';
import { renderActionBar, bitmapPayload } from './icons.mjs';
import { renderDots } from './dots.mjs';

const PAD = 10;
const COL_W = 150;          // Statusspalte links
const DOTS_W = 14;          // gepunktete Leiste
const ACTION_H = 44;
const LINE_H = 26;
const PANEL_X = PAD + COL_W + DOTS_W;
const PANEL_W = DISPLAY_W - PANEL_X - PAD;
const PANEL_Y = 6;
const PANEL_H = DISPLAY_H - ACTION_H - PANEL_Y - 4;

export const CONTAINER = {
  STATUS: 1,
  PANEL_TITLE: 2,
  PANEL_BODY: 3,
  DOTS: 20,
  ACTION_L: 21,
  ACTION_R: 22,
};

const BRIGHT = 4;
const DIM = 2;

export const LEVEL = { RUBRIK: 'rubrik', DETAIL: 'detail' };

/** Zeilen im Panel — Titel belegt die erste. */
export const CONTENT_LINES = Math.floor((PANEL_H - 14) / LINE_H) - 1;

// Zeichen je Zeile im Panel — am Simulator gemessen: rund 9,2 px je Zeichen.
export const PANEL_CHARS = Math.floor((PANEL_W - 24) / 9.2);

/** Linke Spalte: wer, was, wo — knapp, wie die Statusspalte im Dashboard. */
export function statusLines(nav) {
  const section = nav.sections[nav.sectionIndex];
  const lines = [nav.tabs[nav.tabIndex] || ''];
  if (nav.typ) lines.push(nav.typ);
  lines.push('');
  lines.push(`${nav.sectionIndex + 1}/${Math.max(1, nav.sections.length)}`);
  if (nav.tabs.length > 1) lines.push(`Vorgang ${nav.tabIndex + 1}/${nav.tabs.length}`);
  if (section && nav.level === LEVEL.RUBRIK && section.zeilen.length > CONTENT_LINES) {
    lines.push('', 'Druck öffnet');
  }
  return lines;
}

/** Panel-Titel: Rubrik, im Detail mit Seitenzahl. */
export function titleLine(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (!section) return '';
  if (nav.level === LEVEL.DETAIL) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return pages > 1 ? `${section.titel}  ${page + 1}/${pages}` : section.titel;
  }
  return section.titel;
}

/** Panel-Inhalt. */
export function contentLines(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (!section) return ['Keine Inhalte.'];
  return nav.level === LEVEL.DETAIL
    ? pageOf(section, nav.page, CONTENT_LINES).zeilen
    : section.zeilen.slice(0, CONTENT_LINES);
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
  return {
    containerTotalNum: 6,
    textObject: [
      {
        containerID: CONTAINER.STATUS,
        containerName: 'status',
        xPosition: PAD,
        yPosition: PANEL_Y + 6,
        width: COL_W,
        height: PANEL_H,
        content: statusLines(nav).join('\n'),
        textColor: focused ? DIM : BRIGHT,
        isEventCapture: 0,
        zOrderIndex: 0,
      },
      {
        // Das gerahmte Panel — Rahmen und Radius kommen vom Container selbst,
        // wie im Dashboard. Der Titel sitzt in der ersten Zeile.
        containerID: CONTAINER.PANEL_TITLE,
        containerName: 'panel-title',
        xPosition: PANEL_X,
        yPosition: PANEL_Y,
        width: PANEL_W,
        height: PANEL_H,
        content: titleLine(nav),
        textColor: focused ? DIM : BRIGHT,
        borderWidth: 1,
        borderColor: focused ? 5 : 12,
        borderRadius: 10,
        paddingLength: 8,
        isEventCapture: 0,
        zOrderIndex: 1,
      },
      {
        // Eingabe-Container: Inhalt passt IMMER auf eine Seite, sonst scrollt
        // die Brille ihn selbst und die Gesten erreichen die App nicht.
        containerID: CONTAINER.PANEL_BODY,
        containerName: 'panel-body',
        xPosition: PANEL_X + 8,
        yPosition: PANEL_Y + LINE_H + 6,
        width: PANEL_W - 16,
        height: PANEL_H - LINE_H - 14,
        content: contentLines(nav).join('\n'),
        textColor: focused ? DIM : BRIGHT,
        isEventCapture: 1,
        zOrderIndex: 2,
      },
    ],
    imageObject: [
      {
        containerID: CONTAINER.DOTS,
        containerName: 'dots',
        xPosition: PAD + COL_W,
        yPosition: PANEL_Y,
        width: DOTS_W,
        height: Math.min(144, PANEL_H),
        zOrderIndex: 3,
      },
      {
        containerID: CONTAINER.ACTION_L,
        containerName: 'actions-left',
        xPosition: 0,
        yPosition: DISPLAY_H - ACTION_H,
        width: 288,
        height: ACTION_H,
        zOrderIndex: 4,
      },
      {
        containerID: CONTAINER.ACTION_R,
        containerName: 'actions-right',
        xPosition: 288,
        yPosition: DISPLAY_H - ACTION_H,
        width: 288,
        height: ACTION_H,
        zOrderIndex: 5,
      },
    ],
    menuObject: {
      menuItems: nav.icons.map((icon, i) => ({ itemID: i + 1, itemName: icon.label || icon.wert })),
    },
  };
}

export function buildBitmaps(nav) {
  const bar = renderActionBar({
    icons: nav.icons,
    focusIcon: nav.focusIcon,
    width: DISPLAY_W,
    height: ACTION_H,
    detail: nav.detail,
  });
  return [
    bitmapPayload(
      renderDots({ width: DOTS_W, height: Math.min(144, PANEL_H), ...railState(nav) }),
      CONTAINER.DOTS,
    ),
    bitmapPayload(sliceBitmap(bar, 0, 288), CONTAINER.ACTION_L),
    bitmapPayload(sliceBitmap(bar, 288, 288), CONTAINER.ACTION_R),
  ];
}

function sliceBitmap(bmp, x0, width) {
  const out = { width, height: bmp.height, px: new Uint8Array(width * bmp.height) };
  for (let y = 0; y < bmp.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out.px[y * width + x] = bmp.px[y * bmp.width + (x0 + x)] || 0;
    }
  }
  return out;
}
