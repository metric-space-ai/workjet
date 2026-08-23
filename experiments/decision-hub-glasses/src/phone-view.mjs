// Handy-Oberflaeche: hier wird die CTOX-Verbindung eingerichtet und geregelt,
// WAS auf der Brille erscheint. Die Vorgaenge selbst gehoeren auf die Brille;
// unten steht nur eine kompakte Vorschau, damit man sieht, dass Daten fliessen.

import { DECISION_TYPES, GLASS_SECTIONS, MODES, RUHEZEITEN, activeInstance, isLive } from "./settings.mjs";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function card(title, subtitle) {
  const section = el("section", "dh-card");
  const head = el("header", "dh-card-head");
  head.append(el("h2", "dh-card-title", title));
  if (subtitle) head.append(el("p", "dh-card-sub", subtitle));
  section.append(head);
  return section;
}

function field(labelText, control) {
  const wrap = el("label", "dh-field");
  wrap.append(el("span", "dh-field-label", labelText));
  wrap.append(control);
  return wrap;
}

function input(attrs = {}) {
  const node = el("input", "dh-input");
  Object.assign(node, attrs);
  return node;
}

function toggleRow(labelText, checked, onChange) {
  const row = el("label", "dh-toggle");
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  row.append(box, el("span", null, labelText));
  return row;
}

function chipGroup(options, selected, onToggle) {
  const group = el("div", "dh-chips");
  for (const option of options) {
    const active = selected.includes(option.id);
    const chip = el("button", `dh-chip${active ? " is-active" : ""}`, option.label);
    chip.type = "button";
    chip.addEventListener("click", () => onToggle(option.id));
    group.append(chip);
  }
  return group;
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx  { settings, onSettings, onConnect, onDisconnect, onTest,
 *                        status, decisions, currentTitle }
 */
export function renderSettings(root, ctx) {
  const { settings } = ctx;
  root.replaceChildren();

  // --- Betriebsart: zuoberst, weil davon abhaengt, ob eine Entscheidung
  //     wirklich eine Mail verschickt. ---
  const live = isLive(settings);
  const modus = card('Betriebsart', live ? 'Live — Entscheidungen wirken sofort' : 'Demo — es wird nichts versendet');
  const wahl = el('div', 'dh-chips');
  for (const mode of MODES) {
    const aktiv = settings.mode === mode.id;
    const chip = el('button', `dh-chip${aktiv ? ' is-active' : ''}`, mode.label);
    chip.type = 'button';
    chip.addEventListener('click', () => ctx.onSettings({ mode: mode.id }));
    wahl.append(chip);
  }
  modus.append(wahl);
  modus.append(el('p', 'dh-note', MODES.find((m) => m.id === settings.mode)?.hint || ''));
  if (settings.mode === 'live' && !activeInstance(settings)) {
    modus.append(el('p', 'dh-note', 'Ohne verbundene Instanz bleibt es bei Demo-Daten.'));
  }
  root.append(modus);

  // --- Anzeige: wie lange sie stehen bleibt ---
  const anzeige = card("Anzeige", "Nach dieser Ruhezeit blendet die Brille aus");
  const zeiten = el("div", "dh-chips");
  for (const zeit of RUHEZEITEN) {
    const chip = el("button", `dh-chip${settings.ruhezeit === zeit.id ? " is-active" : ""}`, zeit.label);
    chip.type = "button";
    chip.addEventListener("click", () => ctx.onSettings({ ruhezeit: zeit.id }));
    zeiten.append(chip);
  }
  anzeige.append(zeiten);
  anzeige.append(el("p", "dh-note", "Der nächste Handgriff holt sie zurück. Ganz nach oben scrollen blendet sofort aus."));
  root.append(anzeige);

  // --- Verbindung: der Grund, warum diese App auf dem Handy existiert. ---
  const instance = activeInstance(settings);
  const conn = card(
    "CTOX-Verbindung",
    instance
      ? `${instance.name} · ${instance.kind === "managed" ? "ctox.dev" : "eigene Instanz"}`
      : "noch keine Instanz verbunden",
  );

  if (instance) {
    const meta = el("dl", "dh-meta");
    for (const [key, value] of [
      ["Instanz", instance.baseUrl.replace(/^https?:\/\//, "")],
      ["Angemeldet als", instance.user || "unbekannt"],
      ["Rolle", instance.role || "—"],
    ]) {
      meta.append(el("dt", null, key), el("dd", null, value));
    }
    conn.append(meta);

    const row = el("div", "dh-row");
    const test = el("button", "dh-btn", "Verbindung testen");
    test.type = "button";
    test.addEventListener("click", () => ctx.onTest());
    const cut = el("button", "dh-btn dh-btn--no", "Trennen");
    cut.type = "button";
    cut.addEventListener("click", () => ctx.onDisconnect(instance.id));
    row.append(test, cut);
    conn.append(row);
  } else {
    // Der gewollte Weg: den QR aus dem Decision Hub abfotografieren. Ein
    // Zugangstoken auf einem Handy abzutippen ist keine Bedienung.
    const scan = el("button", "dh-btn dh-btn--yes", "QR-Code scannen");
    scan.type = "button";
    scan.addEventListener("click", () => ctx.onScan?.());
    conn.append(scan);
    conn.append(
      el(
        "p",
        "dh-note",
        "Decision Hub im Browser öffnen → Brille koppeln → Code abfotografieren.",
      ),
    );
    conn.append(
      el(
        "p",
        "dh-note",
        "Oder Einladung einfügen: Business OS → Desktop-Einladung. Ein Passwort wird hier nie eingegeben.",
      ),
    );
    const invite = input({
      placeholder: "Einladungslink oder JSON einfügen",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: false,
    });
    conn.append(field("Einladung", invite));
    const connect = el("button", "dh-btn", "Verbinden");
    connect.type = "button";
    connect.addEventListener("click", () => ctx.onConnect(invite.value));
    conn.append(connect);
  }
  root.append(conn);

  // Filter, Abgleichintervall, Vertagungsdauer und Statusblock sind hier
  // rausgeflogen: Einstellungen, die niemand trifft, kosten nur Platz. Der
  // Betriebszustand steht auf der Brille selbst, die Vertagungsdauer wird
  // dort gefragt, wo sie anfaellt — beim Druck auf die Uhr.
}
