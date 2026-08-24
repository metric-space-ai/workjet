// Bild-Bausteine der Brillenseite: Legendenstreifen (Abteilungsname im
// unterbrochenen Rahmen) und Punkte (Abteilungsposition). 4 Bit je Pixel,
// als number[] — Base64 quittiert das Geraet mit sendFailed (rendering.md).

import { createBitmap, fillRect, setPixel, toBmp } from './bitmap.mjs';
import { drawText, textWidth } from './pixel-font.mjs';

const SCALE = 2;   // Massstab 1 ist am Geraet kaum lesbar

export function renderLegend({ title, width, height }) {
  const bmp = createBitmap(width, height);
  fillRect(bmp, 0, 0, width, height, 0);          // deckt die Rahmenlinie ab
  const y = Math.max(0, Math.floor((height - 7 * SCALE) / 2));
  drawText(bmp, title, 6, y, SCALE, 15, setPixel);
  return bmp;
}

export function legendWidth(title) {
  return Math.max(20, Math.min(288, textWidth(String(title), SCALE) + 14));
}

export function bitmapPayload(bmp, containerID) {
  const bytes = toBmp(bmp);
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  return { containerID, imageData: Array.from(bytes), fingerprint: `${bytes.length}:${(h >>> 0).toString(36)}` };
}
