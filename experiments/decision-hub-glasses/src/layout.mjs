// Seitenaufbau der Entscheidungsvorlage auf der Brille.
//
//   ┌───────────────────────────────────────────┐
//   │ Reiter der anstehenden Entscheidungen     │  Kopf (Text)
//   ├──────────────────────────────────────┬────┤
//   │ Rubrik als Karte: MAIL / ANTWORT /   │ ▮  │  Inhalt (Text) + Leiste
//   │ ARBEITSPAKET …                       │ ▯  │  (Bild, gezeichnet)
//   │ Ein Scroll = naechste Rubrik.        │ ▯  │
//   │ Druck = vollstaendige Fassung, dann  │ ↘  │  Leiste muendet unten …
//   ├──────────────────────────────────────┴────┤
//   │  ✓    ✗    ✎    ⌄    ◷                    │  … in die Entscheidungs-Icons
//   └───────────────────────────────────────────┘  (Bild, gezeichnet)

import { DISPLAY_W, DISPLAY_H, BODY_LINES } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { pageOf } from '../../kundenpipeline-module/core/sections.mjs';
import { renderActionBar, bitmapPayload } from './icons.mjs';
import { renderRail } from './rail.mjs';

const PAD_X = 12;
const HEAD_H = 26;
const ACTION_H = 46;
const RAIL_W = 26;
const LINE_H = 26;

export const CONTAINER = {
  HEAD: 1,
  TITLE: 3,
  BODY: 2,
  RAIL: 20,
  ACTION_L: 21,
  ACTION_R: 22,
};

const BRIGHT = 4;
const DIM = 2;

export const LEVEL = { RUBRIK: 'rubrik', DETAIL: 'detail' };

/** Wie viele Zeilen passen in den Inhaltsbereich? */
export const CONTENT_LINES = Math.floor((DISPLAY_H - HEAD_H - ACTION_H - 6) / LINE_H);

/** Kopfzeile: Reiter der anstehenden Entscheidungen, aktiver hervorgehoben. */
export function headLine(nav) {
  const parts = nav.tabs.map((tab, i) =>
    i === nav.tabIndex ? `▐${tab}▌` : ` ${tab} `,
  );
  const line = parts.join('');
  return line.length <= 52 ? line : `${line.slice(0, 49)}...`;
}

/** Kopf der Rubrik-Karte: Titel und — falls mehr folgt — der Hinweis darauf. */
export function titleLine(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (!section) return '';
  if (nav.level === LEVEL.DETAIL) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return pages > 1 ? `${section.titel}   ${page + 1}/${pages}` : section.titel;
  }
  const mehr = section.zeilen.length > CONTENT_LINES - 1;
  return mehr ? `${section.titel}   ⌄ Druck öffnet` : section.titel;
}

/** Inhalt: in der Rubrik-Ebene die Kurzfassung, in der Detail-Ebene die Seite. */
export function contentLines(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (!section) return ['Keine Inhalte.'];
  const lines = nav.level === LEVEL.DETAIL
    ? pageOf(section, nav.page, CONTENT_LINES - 1).zeilen
    : section.zeilen.slice(0, CONTENT_LINES - 1);
  return lines;
}

/** Segmente der Seitenleiste: Rubriken bzw. Seiten der offenen Rubrik. */
export function railState(nav) {
  const section = nav.sections[nav.sectionIndex];
  if (nav.level === LEVEL.DETAIL && section) {
    const { page, pages } = pageOf(section, nav.page, CONTENT_LINES);
    return { count: pages, active: page };
  }
  return { count: nav.sections.length, active: nav.sectionIndex };
}

/**
 * Kompletter Seitenaufbau.
 * @param {object} nav { tabs, tabIndex, sections, sectionIndex, page, level,
 *                       icons, focusIcon, detail }
 */
export function buildPage(nav) {
  const contentW = DISPLAY_W - PAD_X * 2 - RAIL_W;
  const contentY = HEAD_H;
  const contentH = DISPLAY_H - HEAD_H - ACTION_H;
  const rail = railState(nav);

  return {
    containerTotalNum: 6,
    textObject: [
      {
        containerID: CONTAINER.HEAD,
        containerName: 'head',
        xPosition: PAD_X,
        yPosition: 0,
        width: DISPLAY_W - PAD_X * 2,
        height: HEAD_H,
        content: headLine(nav),
        textColor: nav.focusIcon >= 0 ? DIM : BRIGHT,
        isEventCapture: 0,
        zOrderIndex: 0,
      },
      {
        containerID: CONTAINER.TITLE,
        containerName: 'title',
        xPosition: PAD_X,
        yPosition: contentY,
        width: contentW,
        height: LINE_H,
        content: titleLine(nav),
        textColor: BRIGHT,
        isEventCapture: 0,
        zOrderIndex: 5,
      },
      {
        // Eingabe-Container. Sein Inhalt passt IMMER in eine Seite — sonst
        // scrollt die Brille ihn selbst und die Gesten erreichen die App nicht.
        containerID: CONTAINER.BODY,
        containerName: 'body',
        xPosition: PAD_X,
        yPosition: contentY + LINE_H,
        width: contentW,
        height: contentH - LINE_H,
        content: contentLines(nav).join('\n'),
        textColor: nav.focusIcon >= 0 ? DIM : BRIGHT,
        isEventCapture: 1,
        zOrderIndex: 1,
      },
    ],
    imageObject: [
      {
        containerID: CONTAINER.RAIL,
        containerName: 'rail',
        xPosition: DISPLAY_W - RAIL_W - 2,
        yPosition: contentY,
        width: RAIL_W,
        height: Math.min(144, contentH),
        zOrderIndex: 2,
      },
      {
        containerID: CONTAINER.ACTION_L,
        containerName: 'actions-left',
        xPosition: 0,
        yPosition: DISPLAY_H - ACTION_H,
        width: 288,
        height: ACTION_H,
        zOrderIndex: 3,
      },
      {
        containerID: CONTAINER.ACTION_R,
        containerName: 'actions-right',
        xPosition: 288,
        yPosition: DISPLAY_H - ACTION_H,
        width: 288,
        height: ACTION_H,
        zOrderIndex: 4,
      },
    ],
    // Fallback, solange der Druck aufs Icon am Geraet nicht bestaetigt ist.
    menuObject: {
      menuItems: nav.icons.map((icon, i) => ({ itemID: i + 1, itemName: icon.label || icon.wert })),
    },
  };
}

/** Die drei Bitmaps der Seite — Leiste und die beiden Haelften der Icon-Leiste. */
export function buildBitmaps(nav) {
  const contentH = DISPLAY_H - HEAD_H - ACTION_H;
  const rail = railState(nav);
  const bar = renderActionBar({
    icons: nav.icons,
    focusIcon: nav.focusIcon,
    width: DISPLAY_W,
    height: ACTION_H,
    detail: nav.detail,
  });
  // Die Icon-Leiste ist 576 breit, ein Bild darf hoechstens 288 — also zwei.
  const left = sliceBitmap(bar, 0, 288);
  const right = sliceBitmap(bar, 288, 288);
  return [
    bitmapPayload(renderRail({ width: RAIL_W, height: Math.min(144, contentH), ...rail }), CONTAINER.RAIL),
    bitmapPayload(left, CONTAINER.ACTION_L),
    bitmapPayload(right, CONTAINER.ACTION_R),
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
