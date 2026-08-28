// Gepunktete Scroll-Leiste zwischen den Spalten — wie im Geraete-Dashboard.
// Sie zeigt die Position im Panel, ohne wie ein Balken zu wirken.

import { createBitmap, fillRect } from "./bitmap.mjs";

/**
 * Durchgehender Balken fuer die Langfassung: dort blaettert man durch EINEN
 * Text und will sehen, wie weit man ist und wie viel noch kommt. Punkte
 * beantworten das nicht — sie zaehlen Rubriken, nicht Leseweg.
 */
export function renderBar({ width, height, count, active }) {
  const bmp = createBitmap(width, height);
  const x = Math.floor(width / 2) - 2;
  const oben = 6;
  const spur = Math.max(10, height - 12);
  // Die Spur bleibt schwach sichtbar, damit die Gesamtlaenge ablesbar ist.
  fillRect(bmp, x + 1, oben, 2, spur, 4);
  const seiten = Math.max(1, count);
  const hoehe = Math.max(8, Math.floor(spur / seiten));
  const y = oben + Math.round((spur - hoehe) * (seiten > 1 ? active / (seiten - 1) : 0));
  fillRect(bmp, x, y, 4, hoehe, 15);
  return bmp;
}

export function renderDots({ width, height, count, active }) {
  const bmp = createBitmap(width, height);
  const segments = Math.max(1, count);
  const cx = Math.floor(width / 2) - 1;
  // EIN Punkt je Seite, 1:1 — keine synthetische Punktreihe, in die eine
  // Position hineingerechnet wird. Die aktuelle Seite ist der helle Block.
  const pitch = Math.max(8, Math.min(14, Math.floor((height - 12) / Math.max(1, segments))));
  const spanH = (segments - 1) * pitch;
  const top = Math.max(6, Math.floor((height - spanH) / 2));
  for (let i = 0; i < segments; i += 1) {
    const y = top + i * pitch;
    if (i === active) {
      fillRect(bmp, cx - 1, y - 3, 4, 10, 15);
    } else {
      fillRect(bmp, cx, y, 2, 2, 6);
    }
  }
  return bmp;
}
