// Kopplung per QR-Code.
//
// Der Even-Hub-WebView hat keinen direkten Kamerastrom, aber das SDK kann ein
// Foto aufnehmen (`captureImageFromCamera`). Das reicht: Bild aufnehmen, QR
// darin dekodieren, Einladung uebernehmen. Kein Abtippen von Token.

import jsQR from 'jsqr';
import { parseInvite } from './settings.mjs';

/** Base64-Bild → Pixel, die der Dekoder lesen kann. */
async function toImageData(base64, mimeType = 'image/jpeg') {
  const src = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`;
  const bitmap = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
    img.src = src;
  });
  const canvas = document.createElement('canvas');
  // Grosse Fotos unnoetig zu dekodieren kostet Sekunden auf dem Handy.
  const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Foto aufnehmen und die Einladung daraus lesen.
 * @param {{captureImageFromCamera: Function}} bridge
 * @returns {Promise<{ok:true, invite:object}|{ok:false, reason:string}>}
 */
export async function scanInvite(bridge) {
  if (typeof bridge?.captureImageFromCamera !== 'function') {
    return { ok: false, reason: 'Diese App-Version kann die Kamera nicht öffnen.' };
  }
  let asset;
  try {
    asset = await bridge.captureImageFromCamera();
  } catch (error) {
    return { ok: false, reason: error?.message || 'Kamera abgebrochen' };
  }
  if (!asset?.base64) return { ok: false, reason: 'Kein Bild aufgenommen' };

  let image;
  try {
    image = await toImageData(asset.base64, asset.mimeType);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const code = jsQR(image.data, image.width, image.height);
  if (!code?.data) return { ok: false, reason: 'Kein QR-Code im Bild erkannt' };

  const invite = parseInvite(code.data);
  if (!invite) return { ok: false, reason: 'QR-Code enthält keine gültige CTOX-Einladung' };
  return { ok: true, invite };
}
