// Gepunktete Scroll-Leiste zwischen den Spalten — wie im Geraete-Dashboard.
// Sie zeigt die Position im Panel, ohne wie ein Balken zu wirken.

import { createBitmap, fillRect } from './bitmap.mjs';

export function renderDots({ width, height, count, active }) {
  const bmp = createBitmap(width, height);
  const segments = Math.max(1, count);
  const cx = Math.floor(width / 2) - 1;
  const gap = Math.max(6, Math.floor(height / (segments + 1)));
  const top = Math.max(2, Math.floor((height - gap * (segments - 1)) / 2));
  for (let i = 0; i < segments; i += 1) {
    const y = top + i * gap;
    if (i === active) {
      // aktive Position: laenglicher Strich statt Punkt
      fillRect(bmp, cx, y - 3, 3, 10, 15);
    } else {
      fillRect(bmp, cx, y, 2, 2, 7);
    }
  }
  return bmp;
}
