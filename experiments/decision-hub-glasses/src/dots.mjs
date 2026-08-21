// Gepunktete Scroll-Leiste zwischen den Spalten — wie im Geraete-Dashboard.
// Sie zeigt die Position im Panel, ohne wie ein Balken zu wirken.

import { createBitmap, fillRect } from './bitmap.mjs';

export function renderDots({ width, height, count, active }) {
  const bmp = createBitmap(width, height);
  const segments = Math.max(1, count);
  const cx = Math.floor(width / 2) - 1;
  // Wie in der Vorlage: eine gleichmaessige Punktreihe ueber die volle Hoehe,
  // die aktuelle Position als laengerer, heller Block.
  const pitch = 10;
  const dots = Math.max(segments, Math.floor((height - 8) / pitch));
  const top = Math.floor((height - (dots - 1) * pitch) / 2);
  const activeDot = segments > 1
    ? Math.round((active / (segments - 1)) * (dots - 1))
    : Math.floor(dots / 2);
  for (let i = 0; i < dots; i += 1) {
    const y = top + i * pitch;
    if (i === activeDot) {
      fillRect(bmp, cx - 1, y - 4, 4, 12, 15);
    } else {
      fillRect(bmp, cx, y, 2, 2, 6);
    }
  }
  return bmp;
}
