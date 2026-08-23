// Gezeichnete Icons fuer die Entscheidungsleiste.
//
// Die Gerätefont hat weder Haken noch Kreuz, Stift oder Uhr (am Simulator
// geprueft). Also werden sie als Bitmap gezeichnet — das ist auch der einzige
// Weg zu einer Auswahl, die wie ein Bedienelement aussieht statt wie Text.

import { createBitmap, fillRect, setPixel, toBmp, toBase64 } from './bitmap.mjs';

const ZEILE_H = 26;   // eine Listenzeile, wie im Layout

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
export function renderActionBar({ icons, focusIcon, width, height, offsetY = 0, detail = 0, compact = false }) {
  const bmp = createBitmap(width, height);
  const count = icons.length || 1;
  const cell = Math.floor(width / count);
  // Design-Guide: flaechige Icons, Striche >= 2 px. Ein Faktor 1 auf dem
  // 16er-Raster ergibt genau das — groesser wirkt es plump.
  const scale = compact ? 1 : 2;
  const size = ICON_SIZE * scale;
  // Die Leiste belegt nur EINE Zeile des Bildes — welche, sagt offsetY.
  // Dadurch bleibt der Container stehen, waehrend die Leiste dem aktiven
  // Vorgang folgt.
  const zeile = Math.max(0, Math.min(offsetY, Math.max(0, height - ZEILE_H)));
  icons.forEach((icon, i) => {
    const focused = i === focusIcon;
    const x = i * cell + Math.floor((cell - size) / 2);
    const y = zeile + Math.floor((ZEILE_H - size) / 2) - (compact ? 0 : 4);
    // Keine Rahmen um die Aktionen (Owner-Vorgabe). Die Auswahl muss aber
    // auf einen Blick erkennbar sein: ein duenner Strich war es nicht.
    // Gewaehlt = gefuellte Flaeche, Icon ausgespart.
    if (focused) fillRect(bmp, i * cell + 2, zeile + 1, cell - 4, ZEILE_H - 2, ON);
    const key = icon.wert === 'detail' && detail >= 1 ? 'kurz' : NAME[icon.wert] || 'annehmen';
    drawIcon(bmp, key, x, y, scale, focused ? OFF : ON, setPixel);
    if (!compact) {
      const label = (icon.glyph || icon.wert || '').toUpperCase();
      const lw = textWidth(label, 1);
      drawText(bmp, label, i * cell + Math.floor((cell - lw) / 2), y + size + 3, 1, ON, setPixel);
    }
  });
  return bmp;
}

/**
 * Die Vorgangsliste als EIN Bild: Kanal-Icon und Name je Zeile, der aktive
 * Vorgang invertiert. Als Text ginge das nicht — ein Textcontainer kann
 * keine einzelne Zeile hervorheben, und ein ">" davor reicht am Geraet
 * nicht aus, um zu sehen, wo man ist. Zugleich ersetzt dieses eine Bild
 * zwei Container (Icons + Text), was die Funkstrecke entlastet.
 */
export const ZEILE_NAME = 24;   // Zeile mit Kanal-Icon und Name
export const ZEILE_AKTION = 20;  // darunter reservierter Platz fuer Aktionen
export const ZEILE_FALL = ZEILE_NAME + ZEILE_AKTION;

export function renderCaseList({ width, height, cases, active, actions = [], focusAction = -1, demo }) {
  const bmp = createBitmap(width, height);
  cases.forEach((fall, i) => {
    const oben = i * ZEILE_FALL;
    if (oben + ZEILE_NAME > height) return;
    const aktiv = i === active;
    const name = typeof fall === 'string' ? fall : (fall.titel || '');
    const kanal = typeof fall === 'string' ? 'mail' : (fall.kanal || 'mail');

    // Aktiver Vorgang invertiert — ein ">" davor reicht am Geraet nicht,
    // um auf einen Blick zu sehen, wo man ist.
    if (aktiv) fillRect(bmp, 0, oben, width, ZEILE_NAME, ON);
    const farbe = aktiv ? OFF : ON;
    drawIcon(bmp, kanal, 3, oben + Math.floor((ZEILE_NAME - ICON_SIZE) / 2), 1, farbe, setPixel);
    drawText(bmp, name, 3 + ICON_SIZE + 5, oben + Math.floor((ZEILE_NAME - 14) / 2), 2, farbe, setPixel);

    // Der Platz DARUNTER gehoert immer zu diesem Vorgang, ob belegt oder
    // nicht. Erschienen die Aktionen dynamisch, spraenge die ganze Liste.
    if (!aktiv || !actions.length) return;
    const spalte = Math.floor(width / actions.length);
    const gross = ICON_SIZE;
    actions.forEach((icon, k) => {
      const gewaehlt = k === focusAction;
      const x = k * spalte + Math.floor((spalte - gross) / 2);
      const y = oben + ZEILE_NAME + Math.floor((ZEILE_AKTION - gross) / 2);
      if (gewaehlt) fillRect(bmp, k * spalte + 1, oben + ZEILE_NAME, spalte - 2, ZEILE_AKTION, ON);
      drawIcon(bmp, NAME[icon.wert] || 'annehmen', x, y, 1, gewaehlt ? OFF : ON, setPixel);
    });
  });
  if (demo) {
    const y = Math.min(cases.length * ZEILE_FALL, height - 16);
    drawText(bmp, 'DEMO', 3, y, 1, 8, setPixel);
  }
  return bmp;
}

/** Kanal-Icons links neben den Eintraegen — ohne Rahmen, nur das Zeichen. */
export function renderChannelColumn({ width, height, pitch, channels, active, rows }) {
  const bmp = createBitmap(width, height);
  channels.forEach((channel, i) => {
    // `rows` gibt die tatsaechliche Textzeile je Eintrag an: unter dem aktiven
    // Eintrag steht die Icon-Leiste, alles darunter rutscht eine Zeile tiefer.
    const rowIndex = rows ? rows[i] : i;
    const y = rowIndex * pitch + Math.floor((pitch - ICON_SIZE) / 2);
    if (y + ICON_SIZE > height) return;
    const x = Math.floor((width - ICON_SIZE) / 2);
    drawIcon(bmp, channel, x, y, 1, i === active ? ON : 8, setPixel);
  });
  return bmp;
}

/**
 * Die Rubrik sitzt IM Rahmen, nicht darin: dieser Streifen liegt ueber der
 * oberen Rahmenkante und deckt sie auf seiner Breite ab. Dadurch ist der
 * Rahmen genau dort unterbrochen, wo der Name steht — man sieht auf einen
 * Blick, in welcher Rubrik man ist, ohne eine Zeile Inhalt dafuer zu opfern.
 */
const LEGEND_SCALE = 2;   // Massstab 1 war am Geraet kaum zu lesen.

export function renderLegend({ title, width, height }) {
  const bmp = createBitmap(width, height);
  fillRect(bmp, 0, 0, width, height, 0);            // deckt die Rahmenlinie ab
  const y = Math.max(0, Math.floor((height - 7 * LEGEND_SCALE) / 2));
  drawText(bmp, title, 6, y, LEGEND_SCALE, ON, setPixel);
  return bmp;
}

export function legendWidth(title) {
  // 20 ist die kleinste erlaubte Bildbreite, 288 die groesste.
  return Math.max(20, Math.min(288, textWidth(title, LEGEND_SCALE) + 14));
}

export function bitmapPayload(bmp, containerID) {
  // Das Feld heisst imageData (ImageRawDataUpdate); mapRawData gehoert zur
  // Fragment-Variante und wird vom Host mit "no image_data provided" quittiert.
  // Als Bytes statt Base64-Text: das SDK empfiehlt number[] (List<int>), und
  // das Geraet quittierte den Text-Weg mit sendFailed.
  const bytes = toBmp(bmp);
  return { containerID, imageData: Array.from(bytes), fingerprint: bitmapFingerprint(bytes) };
}

/**
 * Fingerabdruck eines Bildes, um unveraenderte nicht erneut zu funken.
 * Drei Bilder bei JEDEM Schritt neu zu senden ueberlastet die Funkstrecke —
 * genau daran scheiterte die Uebertragung.
 */
export function bitmapFingerprint(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return `${bytes.length}:${(h >>> 0).toString(36)}`;
}
