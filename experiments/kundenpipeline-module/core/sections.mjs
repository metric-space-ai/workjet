// Ein Vorgang besteht aus Abschnitten, nicht aus einem Endlostext.
//
// Bedienmodell auf der Brille:
//   Ebene 1  Übersicht — die Abschnitte als Karten, einer ausgewählt.
//   Ebene 2  Abschnitt — vollflächig, seitenweise, mit Scrollleiste.
// Druck öffnet, Doppeldruck geht zurück. Weiterscrollen über das Ende der
// Übersicht führt auf die Entscheidungsleiste.

import { layoutText } from "./glasses-renderer.mjs";

const TITEL = {
  mail: "MAIL",
  antwort: "ANTWORT-VORSCHLAG",
  aufgabe: "AUFGABE",
  notizen: "NOTIZEN",
  routing: "ROUTING",
};

/**
 * Abschnitte einer Entscheidung — jeder mit Titel, Zeilen und einer
 * Kurzfassung für die Übersicht.
 * @param {object} decision
 * @param {object|null} vorgang
 * @param {string[]} erlaubt  Abschnitts-IDs aus den Handy-Einstellungen
 */
export function sectionsOf(
  decision,
  vorgang,
  erlaubt = ["mail", "antwort", "aufgabe", "notizen"],
  width = 52,
) {
  const out = [];
  /**
   * Jeder Abschnitt hat ZWEI Fassungen:
   *   kurz  — worum es geht, auf einer Seite, ohne Scrollen. Das ist eine
   *           Zusammenfassung, KEIN abgeschnittener Originaltext.
   *   lang  — der wesentliche Originaltext, seitenweise lesbar.
   * Ein angeschnittener Satz auf der Übersicht ist unbrauchbar: man muss
   * aufklappen, nur um den ersten Gedanken zu Ende zu lesen.
   */
  const push = (id, lang, kurz) => {
    const volltext = (lang || []).filter((z) => z != null);
    if (!volltext.length || !erlaubt.includes(id)) return;
    const kurzfassung = (kurz || []).filter((z) => z != null);
    out.push({
      id,
      titel: TITEL[id] || id.toUpperCase(),
      // `zeilen` bleibt der Volltext (Langfassung, seitenweise).
      zeilen: volltext,
      // `kurz` ist die eigenständige Zusammenfassung für die Übersicht.
      // Fehlt sie, greift der Volltext — dann wird eben doch gekürzt.
      kurz: kurzfassung.length ? kurzfassung : volltext,
      vorschau: kurzfassung[0] || volltext.find((z) => z.trim()) || "",
    });
  };

  const quelle = vorgang?.quelle_json || {};
  const triageJson = vorgang?.triage_json || {};
  const mail = quelle.body_clean;
  const mailLang = [];
  if (mail) {
    mailLang.push(...layoutText(mail, width));
    // Anhänge gehören in die Langfassung: sie erklären oft erst, worum es geht.
    const anhaenge = quelle.anhaenge || quelle.attachments || [];
    if (anhaenge.length) {
      mailLang.push("", "ANHÄNGE");
      for (const a of anhaenge) {
        const name = typeof a === "string" ? a : a.name || "Anhang";
        const was = typeof a === "string" ? "" : a.beschreibung ? ` — ${a.beschreibung}` : "";
        mailLang.push(...layoutText(`• ${name}${was}`, width));
      }
    }
  }
  push(
    "mail",
    mailLang.length ? mailLang : null,
    triageJson.zusammenfassung ? layoutText(triageJson.zusammenfassung, width) : null,
  );

  const triage = triageJson;
  push(
    "antwort",
    triage?.antwort_vorschlag ? layoutText(triage.antwort_vorschlag, width) : null,
    triage?.antwort_kurz ? layoutText(triage.antwort_kurz, width) : null,
  );

  if (triage?.aufgabe?.beschreibung) {
    const zeilen = [];
    if (triage.aufgabe.agent) zeilen.push(`→ ${triage.aufgabe.agent}`);
    zeilen.push(...layoutText(triage.aufgabe.beschreibung, width));
    const kurz = triage.aufgabe_kurz
      ? [
          triage.aufgabe.agent ? `→ ${triage.aufgabe.agent}` : null,
          ...layoutText(triage.aufgabe_kurz, width),
        ]
      : null;
    push("aufgabe", zeilen, kurz);
  }

  push("notizen", triage?.notizen ? layoutText(triage.notizen, width) : null);

  for (const seite of decision?.detail_seiten_json || []) {
    const id = String(seite.titel || "detail").toLowerCase();
    out.push({
      id,
      titel: String(seite.titel || "DETAIL").toUpperCase(),
      zeilen: seite.zeilen || [],
      kurz: seite.kurz || seite.zeilen || [],
      vorschau: (seite.zeilen || []).find((z) => z.trim()) || "",
    });
  }

  // Ohne Triage bleibt wenigstens die Kurzfassung der Entscheidung selbst,
  // damit die Übersicht nie leer ist.
  if (!out.length && decision?.zeilen_json?.length) {
    out.push({
      id: "kurz",
      titel: "ÜBERSICHT",
      zeilen: decision.zeilen_json,
      vorschau: decision.zeilen_json.find((z) => z.trim()) || "",
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
