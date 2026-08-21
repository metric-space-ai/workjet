// 4-Bit-Graustufen-Bitmaps fuer die Bild-Container der Brille.
//
// Das Pixelformat ist NICHT dokumentiert (nur "4-bit greyscale", max
// 288x144). Die Packung hier — zeilenweise, zwei Pixel je Byte, linkes Pixel
// im hohen Nibble — ist am Simulator gegen ein Testmuster verifiziert.

export const MAX_W = 288;
export const MAX_H = 144;

export function createBitmap(width, height) {
  return { width, height, px: new Uint8Array(width * height) };
}

export function setPixel(bmp, x, y, level) {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  bmp.px[y * bmp.width + x] = Math.max(0, Math.min(15, level | 0));
}

export function fillRect(bmp, x, y, w, h, level) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) setPixel(bmp, xx, yy, level);
  }
}

export function strokeRect(bmp, x, y, w, h, level, thickness = 1) {
  for (let t = 0; t < thickness; t += 1) {
    for (let xx = x + t; xx < x + w - t; xx += 1) {
      setPixel(bmp, xx, y + t, level);
      setPixel(bmp, xx, y + h - 1 - t, level);
    }
    for (let yy = y + t; yy < y + h - t; yy += 1) {
      setPixel(bmp, x + t, yy, level);
      setPixel(bmp, x + w - 1 - t, yy, level);
    }
  }
}

/** Linie von (x0,y0) nach (x1,y1) — Bresenham, mit Strichstaerke. */
export function line(bmp, x0, y0, x1, y1, level, thickness = 2) {
  // Bresenham braucht GANZE Zahlen — mit Kommawerten trifft x0===x1 nie zu
  // und die Schleife laeuft ewig.
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    for (let t = 0; t < thickness; t += 1) {
      setPixel(bmp, x0, y0 + t, level);
      setPixel(bmp, x0 + t, y0, level);
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function circle(bmp, cx, cy, r, level, thickness = 2) {
  for (let a = 0; a < 360; a += 2) {
    const rad = (a * Math.PI) / 180;
    for (let t = 0; t < thickness; t += 1) {
      setPixel(bmp, Math.round(cx + (r - t) * Math.cos(rad)), Math.round(cy + (r - t) * Math.sin(rad)), level);
    }
  }
}

/**
 * 8-Bit-Graustufen-BMP. Der Host dekodiert ein Bildformat und lehnt rohe
 * Pixel ab ("The image format could not be determined"). BMP ist der
 * einfachste Weg, der ohne Canvas auskommt — also auch im Test.
 */
export function toBmp(bmp) {
  const rowSize = Math.ceil(bmp.width / 4) * 4; // Zeilen auf 4 Byte aufgefuellt
  const pixelBytes = rowSize * bmp.height;
  const paletteBytes = 256 * 4;
  const offset = 14 + 40 + paletteBytes;
  const out = new Uint8Array(offset + pixelBytes);
  const view = new DataView(out.buffer);

  out[0] = 0x42; out[1] = 0x4d;              // "BM"
  view.setUint32(2, out.length, true);
  view.setUint32(10, offset, true);
  view.setUint32(14, 40, true);              // BITMAPINFOHEADER
  view.setInt32(18, bmp.width, true);
  view.setInt32(22, bmp.height, true);       // positiv = von unten nach oben
  view.setUint16(26, 1, true);
  view.setUint16(28, 8, true);               // 8 Bit je Pixel
  view.setUint32(34, pixelBytes, true);
  view.setUint32(46, 256, true);

  for (let i = 0; i < 256; i += 1) {
    const p = 14 + 40 + i * 4;
    out[p] = i; out[p + 1] = i; out[p + 2] = i; out[p + 3] = 0;
  }
  for (let y = 0; y < bmp.height; y += 1) {
    const src = (bmp.height - 1 - y) * bmp.width;
    const dst = offset + y * rowSize;
    for (let x = 0; x < bmp.width; x += 1) {
      // 0..15 auf 0..255 spreizen
      out[dst + x] = Math.min(255, bmp.px[src + x] * 17);
    }
  }
  return out;
}

/** Zwei Pixel je Byte, linkes Pixel im hohen Nibble. */
export function pack(bmp) {
  const out = new Uint8Array(Math.ceil((bmp.width * bmp.height) / 2));
  for (let i = 0; i < bmp.px.length; i += 2) {
    const hi = bmp.px[i] & 0x0f;
    const lo = (bmp.px[i + 1] ?? 0) & 0x0f;
    out[i >> 1] = (hi << 4) | lo;
  }
  return out;
}

export function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}
