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
import { drawText, textWidth } from './pixel-font.mjs';

const NAME = {
  annehmen: 'annehmen',
  ablehnen: 'ablehnen',
  korrektur: 'korrektur',
  vertagt: 'vertagt',
  detail: 'mehr',
};

/**
 * Aktionsleiste: Icon plus Beschriftung, kompakt gruppiert statt ueber die
 * ganze Breite verstreut. Die gewaehlte Aktion steht auf gefuellter Flaeche
 * mit ausgespartem Icon — die einzige Auswahl, die monochrom sofort liest.
 */
export function renderActionBar({ icons, focusIcon, width, height, detail = 0, compact = false }) {
  const bmp = createBitmap(width, height);
  const count = icons.length || 1;
  const cell = Math.floor(width / count);
  // Design-Guide: flaechige Icons, Striche >= 2 px. Ein Faktor 1 auf dem
  // 16er-Raster ergibt genau das — groesser wirkt es plump.
  const scale = compact ? 1 : 2;
  const size = ICON_SIZE * scale;
  icons.forEach((icon, i) => {
    const focused = i === focusIcon;
    const x = i * cell + Math.floor((cell - size) / 2);
    const y = Math.floor((height - size) / 2) - (compact ? 0 : 4);
    if (focused) {
      // Auswahl als Rahmen, nicht als Flaeche (Design-Guide).
      const bx = i * cell + 2;
      const bw = cell - 4;
      fillRect(bmp, bx, 2, bw, 1, ON);
      fillRect(bmp, bx, height - 3, bw, 1, ON);
      fillRect(bmp, bx, 2, 1, height - 4, ON);
      fillRect(bmp, bx + bw - 1, 2, 1, height - 4, ON);
    }
    const key = icon.wert === 'detail' && detail >= 1 ? 'kurz' : NAME[icon.wert] || 'annehmen';
    drawIcon(bmp, key, x, y, scale, ON, setPixel);
    if (!compact) {
      const label = (icon.glyph || icon.wert || '').toUpperCase();
      const lw = textWidth(label, 1);
      drawText(bmp, label, i * cell + Math.floor((cell - lw) / 2), y + size + 3, 1, ON, setPixel);
    }
  });
  return bmp;
}

export function bitmapPayload(bmp, containerID) {
  // Das Feld heisst imageData (ImageRawDataUpdate); mapRawData gehoert zur
  // Fragment-Variante und wird vom Host mit "no image_data provided" quittiert.
  return { containerID, imageData: toBase64(toBmp(bmp)) };
}
