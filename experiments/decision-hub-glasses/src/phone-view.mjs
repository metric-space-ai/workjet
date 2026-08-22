// Handy-Oberflaeche: hier wird die CTOX-Verbindung eingerichtet und geregelt,
// WAS auf der Brille erscheint. Die Vorgaenge selbst gehoeren auf die Brille;
// unten steht nur eine kompakte Vorschau, damit man sieht, dass Daten fliessen.

import { DECISION_TYPES, GLASS_SECTIONS, MODES, activeInstance, isLive } from "./settings.mjs";

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
    conn.append(
      el(
        "p",
        "dh-note",
        "Einladung aus CTOX einfügen: Business OS → Desktop-Einladung. Sie enthält Instanz und Zugang; ein Passwort wird hier nie eingegeben.",
      ),
    );
    const invite = input({
      placeholder: "Einladungslink oder JSON einfügen",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: false,
    });
    conn.append(field("Einladung", invite));
    const connect = el("button", "dh-btn dh-btn--yes", "Verbinden");
    connect.type = "button";
    connect.addEventListener("click", () => ctx.onConnect(invite.value));
    conn.append(connect);
  }
  root.append(conn);

  // --- Was auf der Brille erscheint ---
  const filter = card("Auf der Brille zeigen", "Nur diese Entscheidungen erscheinen unterwegs.");
  filter.append(
    chipGroup(DECISION_TYPES, settings.types, (id) => {
      const types = settings.types.includes(id)
        ? settings.types.filter((t) => t !== id)
        : [...settings.types, id];
      // Ohne Typ bliebe die Brille dauerhaft leer — das ist keine Einstellung,
      // das waere ein stiller Ausfall.
      if (types.length) ctx.onSettings({ types });
    }),
  );
  filter.append(el("h3", "dh-sub", "Abschnitte"));
  filter.append(
    chipGroup(GLASS_SECTIONS, settings.sections, (id) => {
      const sections = settings.sections.includes(id)
        ? settings.sections.filter((s) => s !== id)
        : [...settings.sections, id];
      if (sections.length) ctx.onSettings({ sections });
    }),
  );
  root.append(filter);

  // --- Verhalten ---
  const behaviour = card("Verhalten");
  behaviour.append(
    toggleRow("Vor dem Senden nachfragen", settings.confirmBeforeSend, (v) =>
      ctx.onSettings({ confirmBeforeSend: v }),
    ),
  );
  const refresh = input({
    type: "number",
    min: "10",
    max: "600",
    value: String(settings.refreshSeconds),
  });
  refresh.addEventListener("change", () =>
    ctx.onSettings({ refreshSeconds: Math.max(10, Number(refresh.value) || 30) }),
  );
  behaviour.append(field("Abgleich alle (Sekunden)", refresh));
  const snooze = input({
    type: "number",
    min: "5",
    max: "1440",
    value: String(settings.snoozeMinutes),
  });
  snooze.addEventListener("change", () =>
    ctx.onSettings({ snoozeMinutes: Math.max(5, Number(snooze.value) || 60) }),
  );
  behaviour.append(field('„Später" vertagt um (Minuten)', snooze));
  root.append(behaviour);

  // --- Diagnose ---
  const diag = card("Status");
  const list = el("dl", "dh-meta");
  for (const [key, value] of [
    ["Offene Entscheidungen", String(ctx.decisions ?? 0)],
    ["Letzter Abgleich", ctx.status?.lastSync || "—"],
    ["Auf der Brille", ctx.currentTitle || "—"],
    ["Letzter Fehler", ctx.status?.lastError || "keiner"],
  ]) {
    list.append(el("dt", null, key), el("dd", null, value));
  }
  diag.append(list);
  const testCard = el("button", "dh-btn", "Testkarte an Brille senden");
  testCard.type = "button";
  testCard.addEventListener("click", () => ctx.onTestCard());
  diag.append(testCard);
  root.append(diag);
}
