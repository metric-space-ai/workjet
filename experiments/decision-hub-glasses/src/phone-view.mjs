// Die Handy-Oberflaeche des Decision Hub.
//
// Das Handy ist KEIN Spiegel der Brille: es hat Farbe, Flaeche und
// Touch-Bedienung. Also wird hier der Vorgang selbst dargestellt — Mail,
// Antwortvorschlag, Aufgabe — und nicht das 576x288-Zeilenraster.

const TYP_LABEL = {
  zuordnung: 'Zuordnung',
  triage: 'Triage',
  mailfreigabe: 'Mailfreigabe',
  ergebnisfreigabe: 'Ergebnis',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function section(title, body) {
  const wrap = el('section', 'dh-sec');
  wrap.append(el('h2', 'dh-sec-title', title));
  if (typeof body === 'string') wrap.append(el('p', 'dh-sec-body', body));
  else if (body) wrap.append(body);
  return wrap;
}

/** Wer der Absender ist — Kundenname, sonst die Adresse. */
export function absenderLabel(vorgang) {
  return (
    vorgang?.kunde_name
    || vorgang?.quelle_json?.absender
    || 'Unbekannter Absender'
  );
}

export function renderPhone(root, { decisions, index, vorgangOf, onSelect, busy }) {
  root.replaceChildren();
  const decision = decisions[index];

  if (!decision) {
    const empty = el('div', 'dh-empty');
    empty.append(el('p', 'dh-empty-title', 'Keine offene Entscheidung'));
    empty.append(el('p', 'dh-empty-hint', 'Neue Kundenmails erscheinen hier automatisch.'));
    root.append(empty);
    return;
  }

  const vorgang = vorgangOf(decision);

  // Reiter aller offenen Vorgaenge — antippbar, nicht nur Text wie auf der Brille.
  if (decisions.length > 1) {
    const chips = el('div', 'dh-chips');
    decisions.forEach((item, i) => {
      const chip = el('button', `dh-chip${i === index ? ' is-active' : ''}`, absenderLabel(vorgangOf(item)));
      chip.type = 'button';
      chip.addEventListener('click', () => onSelect(i));
      chips.append(chip);
    });
    root.append(chips);
  }

  const head = el('header', 'dh-case');
  head.append(el('span', 'dh-kicker', TYP_LABEL[decision.typ] || decision.typ || ''));
  head.append(el('h1', 'dh-title', vorgang?.title || decision.titel || ''));
  const from = vorgang?.quelle_json?.absender;
  if (from) head.append(el('p', 'dh-from', from));
  root.append(head);

  const mail = vorgang?.quelle_json?.body_clean;
  if (mail) root.append(section('Mail', mail));

  const triage = vorgang?.triage_json;
  if (triage?.antwort_vorschlag) root.append(section('Antwortvorschlag', triage.antwort_vorschlag));
  if (triage?.aufgabe?.beschreibung) {
    const task = el('div');
    if (triage.aufgabe.agent) task.append(el('p', 'dh-agent', `→ ${triage.aufgabe.agent}`));
    task.append(el('p', 'dh-sec-body', triage.aufgabe.beschreibung));
    root.append(section('Aufgabe', task));
  }
  if (triage?.notizen) root.append(section('Notizen', triage.notizen));

  // Ohne Triage: zeigen, worauf gewartet wird, statt eine leere Seite.
  if (!triage && decision.typ === 'zuordnung') {
    root.append(section('Offen', 'Dieser Vorgang ist noch keinem Projekt zugeordnet.'));
  }

  if (busy) root.append(el('p', 'dh-busy', 'wird ausgeführt …'));
}
