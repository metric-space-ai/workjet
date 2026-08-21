// Referenz-Renderer für die Even-Realities-Anzeige: 576×288 logische Pixel,
// grün-monochrom, 16 Helligkeitsstufen. Dasselbe Modell rendert später das
// Even-Hub-Plugin auf der Brille; dies ist die Desktop-Vorschau.
//
// Bedienmodell (ein durchgehender Scroll-Fluss, Vorgabe des Owners):
//   Oben: Reiter aller offenen Items, aktiver hell.
//   Darunter: der Volltext des Items, zeilenweise scrollbar (Swipe/Rad).
//   Unten: eine kompakte Icon-Zeile (Entscheidungen). Wer ans Textende
//   scrollt, scrollt WEITER auf die Icons (Fokus wandert von Icon zu Icon,
//   invers dargestellt); über das letzte Icon hinaus beginnt das nächste
//   Item. Press aktiviert das fokussierte Icon. Double-Press führt zurück
//   in den Text.

export const DISPLAY_W = 576;
export const DISPLAY_H = 288;

// Am Simulator gemessen (evenhub-simulator, 576x288): die Systemschrift der
// Brille setzt mit 26 px Zeilenabstand. Die Textgroesse ist nicht einstellbar
// (TextContainerProperty kennt kein Font-Feld), also ist die Geometrie hier
// keine Designentscheidung, sondern der Messwert.
const PAD_X = 14;
const TAB_H = 25;
const ICON_H = 33;
const LINE_H = 26;
const ICON_W = 40;
const ICON_GAP = 8;

// Am Geraet nachgemessen (Simulator-Screenshots): mit Reiterzeile UND
// Entscheidungszeile bleiben 8 Textzeilen. Neun wurden unten angeschnitten —
// 288 px / 26 px sind 11 Zeilen, und Reiter plus Icons kosten zwei davon.
// Die vom Owner erhofften 10 Zeilen sind physikalisch nicht drin.
export const BODY_LINES = Math.floor((DISPLAY_H - TAB_H - ICON_H - 6) / LINE_H); // 8

// 16 Grünstufen (0 = aus, 15 = volle Helligkeit).
export function green(level) {
  const l = Math.max(0, Math.min(15, Math.round(level)));
  const v = l / 15;
  return `rgb(${Math.round(24 * v)},${Math.round(255 * v)},${Math.round(70 * v)})`;
}

const FONT = (px, bold = false) => `${bold ? '700 ' : ''}${px}px "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, monospace`;

// Ansicht: { tabs:[{label,active}], zeilen, scroll, icons:[{glyph,label}],
//            focusIcon (-1 = im Text) }
export function renderView(canvas, view) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  ctx.textBaseline = 'top';
  if (!view) {
    ctx.fillStyle = green(6);
    ctx.font = FONT(22);
    ctx.fillText('Keine offenen Entscheidungen', PAD_X, 130);
    return;
  }

  // Reiterleiste: alle Items; rechts die Scrollposition.
  const tabs = view.tabs || [];
  ctx.font = FONT(15);
  const zeilen = view.zeilen || [];
  const scroll = clampScroll(view.scroll || 0, zeilen.length);
  const pos = zeilen.length > BODY_LINES
    ? `${Math.min(zeilen.length, scroll + BODY_LINES)}/${zeilen.length}`
    : '';
  const posW = pos ? ctx.measureText(pos).width + 12 : 0;
  if (pos) {
    ctx.fillStyle = green(6);
    ctx.fillText(pos, DISPLAY_W - PAD_X - posW + 12, 5);
  }
  if (tabs.length) {
    const tabW = (DISPLAY_W - PAD_X * 2 - posW) / tabs.length;
    tabs.forEach((tab, i) => {
      const x = PAD_X + i * tabW;
      ctx.fillStyle = tab.active ? green(14) : green(6);
      const label = clip(ctx, tab.label || String(i + 1), tabW - 10);
      ctx.fillText(label, x + 4, 5);
      if (tab.active) {
        ctx.fillStyle = green(12);
        ctx.fillRect(x + 2, TAB_H - 5, Math.max(18, ctx.measureText(label).width + 6), 2);
      }
    });
  }

  // Textkörper: scrollbares Fenster über den Volltext.
  ctx.font = FONT(17);
  for (let i = 0; i < BODY_LINES; i += 1) {
    const zeile = zeilen[scroll + i];
    if (zeile === undefined) break;
    ctx.fillStyle = String(zeile).startsWith('▸') ? green(8) : green(12);
    ctx.fillText(clip(ctx, zeile, DISPLAY_W - PAD_X * 2 - 8), PAD_X, TAB_H + i * LINE_H);
  }

  // Scroll-Indikator rechts (nur Textbereich).
  if (zeilen.length > BODY_LINES) {
    const trackTop = TAB_H;
    const trackH = DISPLAY_H - TAB_H - ICON_H - 4;
    ctx.fillStyle = green(3);
    ctx.fillRect(DISPLAY_W - 5, trackTop, 3, trackH);
    const thumbH = Math.max(16, trackH * (BODY_LINES / zeilen.length));
    const thumbY = trackTop + (trackH - thumbH) * (scroll / (zeilen.length - BODY_LINES));
    ctx.fillStyle = green(11);
    ctx.fillRect(DISPLAY_W - 5, thumbY, 3, thumbH);
  }

  // Icon-Zeile unten: kompakte Entscheidungs-Icons, Fokus invers.
  const icons = view.icons || [];
  const iconY = DISPLAY_H - ICON_H + 4;
  ctx.font = FONT(17, true);
  icons.forEach((icon, i) => {
    const x = PAD_X + i * (ICON_W + ICON_GAP);
    const focused = view.focusIcon === i;
    if (focused) {
      ctx.fillStyle = green(14);
      roundRect(ctx, x, iconY, ICON_W, 24, 5);
      ctx.fill();
      ctx.fillStyle = 'rgb(0,0,0)';
    } else {
      ctx.strokeStyle = green(view.focusIcon >= 0 ? 7 : 5);
      ctx.lineWidth = 1.5;
      roundRect(ctx, x, iconY, ICON_W, 24, 5);
      ctx.stroke();
      ctx.fillStyle = green(9);
    }
    const gw = ctx.measureText(icon.glyph).width;
    ctx.fillText(icon.glyph, x + (ICON_W - gw) / 2, iconY + 3);
  });
  // Label des fokussierten Icons rechts neben der Zeile.
  if (view.focusIcon >= 0 && icons[view.focusIcon]) {
    ctx.font = FONT(14);
    ctx.fillStyle = green(11);
    ctx.fillText(
      clip(ctx, icons[view.focusIcon].label || '', DISPLAY_W - PAD_X * 2 - icons.length * (ICON_W + ICON_GAP) - 8),
      PAD_X + icons.length * (ICON_W + ICON_GAP) + 6,
      iconY + 5
    );
  }
}

export function clampScroll(scroll, totalLines, windowLines = BODY_LINES) {
  return Math.max(0, Math.min(scroll, Math.max(0, totalLines - windowLines)));
}

// Trefferprüfung für Desktop-Klicks direkt auf dem Canvas.
export function hitTest(view, x, y) {
  if (!view) return null;
  if (y < TAB_H && view.tabs?.length) {
    const posW = 60;
    const tabW = (DISPLAY_W - PAD_X * 2 - posW) / view.tabs.length;
    const index = Math.floor((x - PAD_X) / tabW);
    if (index >= 0 && index < view.tabs.length) return { typ: 'tab', index };
  }
  if (y >= DISPLAY_H - ICON_H && view.icons?.length) {
    const index = Math.floor((x - PAD_X) / (ICON_W + ICON_GAP));
    if (index >= 0 && index < view.icons.length
      && (x - PAD_X) % (ICON_W + ICON_GAP) <= ICON_W) return { typ: 'icon', index };
  }
  return null;
}

// ---------- Modellaufbau ----------

// Volltext eines Entscheidungs-Records (inkl. Detail-Seiten als Abschnitte).
export function decisionLines(decision) {
  const zeilen = [...(decision.zeilen_json || [])];
  for (const seite of decision.detail_seiten_json || []) {
    zeilen.push('', `» ${seite.titel || ''}`.trimEnd());
    zeilen.push(...(seite.zeilen || []));
  }
  while (zeilen.length && zeilen[0] === '') zeilen.shift();
  return zeilen;
}

// Entscheidungs-Icons: kompakt, feste Reihenfolge der Bedienfläche.
export function decisionIcons(decision, copy = {}) {
  const icons = [];
  const aktionen = decision?.aktionen_json?.length ? decision.aktionen_json : [
    { wert: 'annehmen' }, { wert: 'ablehnen' }
  ];
  // Die Brillenschrift hat WEDER ✓/✔ NOCH ✗/✘ NOCH ✎/◷ (am Simulator
  // verifiziert). Kurze Woerter sind dort eindeutiger als ersatzweise
  // Symbole; der Fokus wird durch das Caret ▶ markiert, das es gibt.
  const glyphs = { annehmen: 'OK', ablehnen: 'NEIN' };
  for (const aktion of aktionen) {
    if (aktion.wert === 'details') continue;
    icons.push({
      glyph: glyphs[aktion.wert] || String(aktion.wert || '').toUpperCase(),
      wert: aktion.wert || 'annehmen',
      label: aktion.label || copy[`action_${aktion.wert}`] || aktion.wert
    });
  }
  icons.push({ glyph: 'KORREKTUR', wert: 'korrektur', label: copy.action_correct || 'Korrektur diktieren' });
  icons.push({ glyph: 'SPÄTER', wert: 'vertagt', label: copy.action_snooze || 'Auf später' });
  return icons;
}

// Kompakter Reiter-Text: Kunde/Absender vor Typ, hart gekürzt.
export function tabLabel(decision, vorgang) {
  const basis = vorgang?.kunde_name || vorgang?.quelle_json?.absender || decision.titel || '';
  return String(basis).split(/[@\s]/)[0].slice(0, 12) || typLabel(decision.typ);
}

export function buildView(state) {
  const { decisions, index, focusIcon, scroll, vorgangOf, copy } = state;
  const decision = decisions[index];
  if (!decision) return null;
  // Die Reiterleiste IST der Kopf — kein Kicker-/Titelblock im Text.
  const zeilen = decisionLines(decision);
  return {
    tabs: decisions.map((d, i) => ({ label: tabLabel(d, vorgangOf(d)), active: i === index })),
    zeilen,
    scroll,
    icons: decisionIcons(decision, copy),
    focusIcon
  };
}

export function typLabel(typ) {
  return {
    zuordnung: 'ZUORDNUNG',
    triage: 'TRIAGE',
    mailfreigabe: 'MAILFREIGABE',
    ergebnisfreigabe: 'ERGEBNIS'
  }[typ] || String(typ || '').toUpperCase();
}

// Fließtext → Zeilen (Monospace 17px ≈ 52 Zeichen je Zeile).
export function layoutText(text, width = 52) {
  const lines = [];
  for (const absatz of String(text || '').split(/\n/)) {
    if (!absatz.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of absatz.trim().split(/\s+/)) {
      if ((`${line} ${word}`).trim().length > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = `${line} ${word}`.trim();
      }
    }
    if (line) lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function clip(ctx, text, maxWidth) {
  let value = String(text || '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
