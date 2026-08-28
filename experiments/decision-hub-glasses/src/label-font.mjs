// Beschriftungen scharf setzen.
//
// Die eingebaute 5x7-Pixelschrift kann nur Grossbuchstaben und wirkt
// vergroessert klotzig. Im WebView gibt es ein Canvas: damit laesst sich
// mit einer echten Schrift setzen. Betrifft NUR kurze Beschriftungen
// (Vorgangsnamen, Rubrikstreifen) — der Flauftext bleibt beim schnellen
// Textcontainer der Brille.

import { drawText, textWidth } from "./pixel-font.mjs";
import { setPixel } from "./bitmap.mjs";

const SCHRIFT = '-apple-system, "Helvetica Neue", Arial, sans-serif';

function canvasDa() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

/**
 * Beschriftung in ein Bitmap setzen. Ohne Canvas (Tests) faellt es auf die
 * Pixelschrift zurueck, damit die Geometrie gleich bleibt.
 * @returns {number} die belegte Breite
 */
export function drawLabel(bmp, text, x, y, px, level = 15, bold = false) {
  if (!canvasDa()) {
    const scale = Math.max(1, Math.round(px / 9));
    drawText(bmp, text, x, y, scale, level, setPixel);
    return textWidth(String(text), scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.font = `${bold ? "600 " : ""}${px}px ${SCHRIFT}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#fff";
  ctx.fillText(String(text), x, y);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  // Harte Kante: Zwischenwerte stellt das Display als Raster dar.
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    if (data[i] >= 128) bmp.px[p] = level;
  }
  return ctx.measureText(String(text)).width;
}

/** Breite einer Beschriftung, ohne zu zeichnen. */
export function labelWidth(text, px, bold = false) {
  if (!canvasDa()) return textWidth(String(text), Math.max(1, Math.round(px / 9)));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${bold ? "600 " : ""}${px}px ${SCHRIFT}`;
  return ctx.measureText(String(text)).width;
}
