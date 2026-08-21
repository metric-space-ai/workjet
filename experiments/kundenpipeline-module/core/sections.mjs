// Ein Vorgang besteht aus Abschnitten, nicht aus einem Endlostext.
//
// Bedienmodell auf der Brille:
//   Ebene 1  Übersicht — die Abschnitte als Karten, einer ausgewählt.
//   Ebene 2  Abschnitt — vollflächig, seitenweise, mit Scrollleiste.
// Druck öffnet, Doppeldruck geht zurück. Weiterscrollen über das Ende der
// Übersicht führt auf die Entscheidungsleiste.

import { layoutText } from './glasses-renderer.mjs';

const TITEL = {
  mail: 'MAIL',
  antwort: 'ANTWORT-VORSCHLAG',
  aufgabe: 'AUFGABE',
  notizen: 'NOTIZEN',
  routing: 'ROUTING',
};

/**
 * Abschnitte einer Entscheidung — jeder mit Titel, Zeilen und einer
 * Kurzfassung für die Übersicht.
 * @param {object} decision
 * @param {object|null} vorgang
 * @param {string[]} erlaubt  Abschnitts-IDs aus den Handy-Einstellungen
 */
export function sectionsOf(decision, vorgang, erlaubt = ['mail', 'antwort', 'aufgabe', 'notizen'], width = 52) {
  const out = [];
  const push = (id, zeilen) => {
    const gefiltert = (zeilen || []).filter((z) => z != null);
    if (!gefiltert.length || !erlaubt.includes(id)) return;
    out.push({
      id,
      titel: TITEL[id] || id.toUpperCase(),
      zeilen: gefiltert,
      // Vorschau: die erste inhaltliche Zeile, hart gekürzt.
      vorschau: gefiltert.find((z) => z.trim()) || '',
    });
  };

  const mail = vorgang?.quelle_json?.body_clean;
  push('mail', mail ? layoutText(mail, width) : null);

  const triage = vorgang?.triage_json;
  push('antwort', triage?.antwort_vorschlag ? layoutText(triage.antwort_vorschlag, width) : null);

  if (triage?.aufgabe?.beschreibung) {
    const zeilen = [];
    if (triage.aufgabe.agent) zeilen.push(`→ ${triage.aufgabe.agent}`);
    zeilen.push(...layoutText(triage.aufgabe.beschreibung, width));
    push('aufgabe', zeilen);
  }

  push('notizen', triage?.notizen ? layoutText(triage.notizen, width) : null);

  for (const seite of decision?.detail_seiten_json || []) {
    const id = String(seite.titel || 'detail').toLowerCase();
    out.push({
      id,
      titel: String(seite.titel || 'DETAIL').toUpperCase(),
      zeilen: seite.zeilen || [],
      vorschau: (seite.zeilen || []).find((z) => z.trim()) || '',
    });
  }

  // Ohne Triage bleibt wenigstens die Kurzfassung der Entscheidung selbst,
  // damit die Übersicht nie leer ist.
  if (!out.length && decision?.zeilen_json?.length) {
    out.push({
      id: 'kurz',
      titel: 'ÜBERSICHT',
      zeilen: decision.zeilen_json,
      vorschau: decision.zeilen_json.find((z) => z.trim()) || '',
    });
  }
  return out;
}

/** Seitenweise blättern: welche Zeilen zeigt Seite `page`? */
export function pageOf(section, page, lines) {
  const total = Math.max(1, Math.ceil(section.zeilen.length / lines));
  const safe = Math.max(0, Math.min(page, total - 1));
  return {
    zeilen: section.zeilen.slice(safe * lines, safe * lines + lines),
    page: safe,
    pages: total,
  };
}
