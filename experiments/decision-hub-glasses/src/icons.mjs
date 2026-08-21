// Gezeichnete Icons fuer die Entscheidungsleiste.
//
// Die Gerätefont hat weder Haken noch Kreuz, Stift oder Uhr (am Simulator
// geprueft). Also werden sie als Bitmap gezeichnet — das ist auch der einzige
// Weg zu einer Auswahl, die wie ein Bedienelement aussieht statt wie Text.

import { createBitmap, fillRect, setPixel, toBmp, toBase64 } from './bitmap.mjs';

const ON = 15;
const OFF = 0;
const SOFT = 7;

/** Haken. */
function drawCheck(bmp, x, y, s, level) {
  line(bmp, x + s * 0.12, y + s * 0.52, x + s * 0.4, y + s * 0.78, level, 3);
  line(bmp, x + s * 0.4, y + s * 0.78, x + s * 0.88, y + s * 0.18, level, 3);
}

/** Kreuz. */
function drawCross(bmp, x, y, s, level) {
  line(bmp, x + s * 0.18, y + s * 0.18, x + s * 0.82, y + s * 0.82, level, 3);
  line(bmp, x + s * 0.82, y + s * 0.18, x + s * 0.18, y + s * 0.82, level, 3);
}

/** Stift (Korrektur diktieren). */
function drawPencil(bmp, x, y, s, level) {
  line(bmp, x + s * 0.2, y + s * 0.8, x + s * 0.72, y + s * 0.24, level, 3);
  line(bmp, x + s * 0.72, y + s * 0.24, x + s * 0.84, y + s * 0.36, level, 2);
  line(bmp, x + s * 0.84, y + s * 0.36, x + s * 0.32, y + s * 0.9, level, 3);
  line(bmp, x + s * 0.2, y + s * 0.8, x + s * 0.32, y + s * 0.9, level, 2);
}

/** Uhr (auf später). */
function drawClock(bmp, x, y, s, level) {
  const cx = x + s / 2;
  const cy = y + s / 2;
  circle(bmp, cx, cy, s * 0.4, level, 2);
  line(bmp, cx, cy, cx, cy - s * 0.24, level, 2);
  line(bmp, cx, cy, cx + s * 0.2, cy, level, 2);
}

/** Doppelpfeil nach unten (mehr Details). */
function drawMore(bmp, x, y, s, level) {
  line(bmp, x + s * 0.2, y + s * 0.28, x + s * 0.5, y + s * 0.54, level, 3);
  line(bmp, x + s * 0.5, y + s * 0.54, x + s * 0.8, y + s * 0.28, level, 3);
  line(bmp, x + s * 0.2, y + s * 0.56, x + s * 0.5, y + s * 0.82, level, 3);
  line(bmp, x + s * 0.5, y + s * 0.82, x + s * 0.8, y + s * 0.56, level, 3);
}

/** Doppelpfeil nach oben (Kurzfassung). */
function drawLess(bmp, x, y, s, level) {
  line(bmp, x + s * 0.2, y + s * 0.54, x + s * 0.5, y + s * 0.28, level, 3);
  line(bmp, x + s * 0.5, y + s * 0.28, x + s * 0.8, y + s * 0.54, level, 3);
  line(bmp, x + s * 0.2, y + s * 0.82, x + s * 0.5, y + s * 0.56, level, 3);
  line(bmp, x + s * 0.5, y + s * 0.56, x + s * 0.8, y + s * 0.82, level, 3);
}

import { drawIcon, ICON_SIZE } from './pixel-icons.mjs';

const NAME = {
  annehmen: 'annehmen',
  ablehnen: 'ablehnen',
  korrektur: 'korrektur',
  vertagt: 'vertagt',
  detail: 'mehr',
};

/**
 * Aktionsleiste im Stil des Geraete-Dashboards: keine Rahmen, keine Kaesten —
 * nur die Icons mit viel Luft. Ausgewaehlt heisst gefuellte Flaeche mit
 * ausgespartem Icon; das ist auf monochrom gruen sofort erkennbar.
 */
export function renderActionBar({ icons, focusIcon, width, height, detail = 0 }) {
  const bmp = createBitmap(width, height);
  const count = icons.length || 1;
  const cell = Math.floor(width / count);
  const scale = Math.max(1, Math.floor(Math.min(cell - 16, height - 12) / ICON_SIZE));
  const size = ICON_SIZE * scale;
  icons.forEach((icon, i) => {
    const focused = i === focusIcon;
    const x = i * cell + Math.floor((cell - size) / 2);
    const y = Math.floor((height - size) / 2);
    if (focused) {
      // Gefuellte Flaeche mit weichen Ecken statt Rahmen.
      const px = i * cell + 6;
      const pw = cell - 12;
      fillRect(bmp, px, 3, pw, height - 6, ON);
      fillRect(bmp, px - 1, 5, 1, height - 10, ON);
      fillRect(bmp, px + pw, 5, 1, height - 10, ON);
    }
    const key = icon.wert === 'detail' && detail >= 1 ? 'kurz' : NAME[icon.wert] || 'annehmen';
    drawIcon(bmp, key, x, y, scale, focused ? OFF : ON, setPixel);
  });
  return bmp;
}

export function bitmapPayload(bmp, containerID) {
  // Das Feld heisst imageData (ImageRawDataUpdate); mapRawData gehoert zur
  // Fragment-Variante und wird vom Host mit "no image_data provided" quittiert.
  return { containerID, imageData: toBase64(toBmp(bmp)) };
}
