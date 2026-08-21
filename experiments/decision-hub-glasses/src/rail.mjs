// Die Seitenleiste: zeigt, wo man in der Entscheidungsvorlage steht, und
// mündet unten in die Entscheidungs-Icons. Sie ist gezeichnet, nicht getippt —
// als Text waere sie wieder nur eine Zeichenkette.

import { createBitmap, fillRect, line, setPixel } from './bitmap.mjs';

const ON = 15;
const SOFT = 6;
const DIM = 3;

/**
 * Vertikale Leiste mit einem Segment je Rubrik (bzw. je Seite im Detail).
 * Das aktive Segment ist gefuellt, die uebrigen sind angedeutet. Unten laeuft
 * die Leiste in einen Bogen aus, der zur Aktionsleiste fuehrt.
 */
export function renderRail({ width, height, count, active, junction = true }) {
  const bmp = createBitmap(width, height);
  const cx = Math.floor(width / 2);
  const top = 6;
  const bottom = height - (junction ? 26 : 6);
  const span = Math.max(1, bottom - top);

  // Führungslinie
  for (let y = top; y < bottom; y += 1) setPixel(bmp, cx, y, DIM);

  const segments = Math.max(1, count);
  const segH = Math.max(6, Math.floor(span / segments) - 3);
  for (let i = 0; i < segments; i += 1) {
    const y = top + Math.floor((span * i) / segments);
    const level = i === active ? ON : SOFT;
    const w = i === active ? width - 6 : 3;
    fillRect(bmp, cx - Math.floor(w / 2), y, w, segH, level);
  }

  if (junction) {
    // Bogen in die Aktionsleiste: die Leiste endet nicht, sie fuehrt weiter.
    line(bmp, cx, bottom, cx, height - 14, SOFT, 2);
    line(bmp, cx, height - 14, cx - 10, height - 4, SOFT, 2);
  }
  return bmp;
}
