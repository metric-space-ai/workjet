// Datenquelle des Plugins.
//
// Bis der Transport zur Instanz steht (Karten-Schnittstelle mit Gerätetoken),
// liefert eine Fixture echte Struktur statt erfundener Verfügbarkeit: dieselben
// Felder, die decision_hub.rs schreibt. So ist am Simulator sichtbar, wie eine
// echte Kundenmail aussieht — ohne vorzutäuschen, es sei bereits verbunden.

const FIXTURE = {
  "vorgaenge": [
    {
      "id": "v-demo-1",
      "kunde_name": "REM Capital",
      "quelle_json": {
        "kanal": "mail",
        "absender": "jill@example.org",
        "betreff": "API-Key funktioniert nicht",
        "body_clean": "Guten Morgen, seit heute früh meldet unser Portal beim Login einen CORS-Fehler und der API-Key wird abgelehnt. Betroffen sind alle Mandanten, die sich über das Kundenportal anmelden; über die API direkt funktioniert es weiterhin. Der Fehler trat erstmals um 06:40 auf, kurz nach dem nächtlichen Deployment. Wir haben bereits geprüft, ob bei uns eine Konfiguration geändert wurde — das war nicht der Fall. Bitte prüfen Sie die CORS-Header und den Ablauf des API-Keys. Wir brauchen eine Lösung bis Freitag, sonst können sich unsere Kunden am Wochenende nicht anmelden.",
        "anhaenge": [
          {
            "name": "portal-fehler.png",
            "beschreibung": "Bildschirmfoto der Fehlermeldung beim Login"
          },
          {
            "name": "har-mitschnitt.har",
            "beschreibung": "Netzwerkmitschnitt, zeigt die abgewiesene Anfrage"
          }
        ]
      },
      "triage_json": {
        "einordnung": "arbeit",
        "aufwand": "M",
        "antwort_vorschlag": "Danke für die Meldung und die genaue Zeitangabe. Wir prüfen die CORS-Konfiguration und den Ablauf des API-Keys umgehend und melden uns heute mit einem Zwischenstand. Sollte die Ursache an einer Änderung auf unserer Seite liegen, beheben wir sie vor Freitag. Für den Fall, dass wir die Ursache nicht bis heute Abend eingrenzen können, richten wir Ihnen einen temporären Zugang ein, damit Ihre Kunden sich anmelden können.",
        "aufgabe": {
          "agent": "Sol · Completion",
          "beschreibung": "CORS-Header und API-Key-Ablauf im Kundenportal prüfen. Einstieg ist das Deployment von gestern Abend; zuerst die geänderten Header-Regeln und die Gültigkeitsdauer der Keys vergleichen. Ergebnis: Ursache benennen, Fix vorschlagen, Risiko für andere Mandanten einschätzen. Kein Fix ohne Freigabe ausrollen."
        },
        "notizen": "Die Frist Freitag ist vom Kunden gesetzt und nicht verhandelt. Vertrauen mittel: die Ursache ist noch nicht belegt, der zeitliche Zusammenhang mit dem Deployment ist aber deutlich.",
        "zusammenfassung": "REM Capital kommt seit dem Deployment von gestern Abend nicht mehr ins Kundenportal. CORS-Fehler beim Login, API-Key abgelehnt. Alle Mandanten betroffen, die API direkt läuft. Frist Freitag.",
        "antwort_kurz": "Zusage, heute mit Zwischenstand zu antworten, Fix vor Freitag, notfalls temporärer Zugang.",
        "aufgabe_kurz": "CORS-Header und API-Key-Ablauf prüfen, Ursache benennen, Fix vorschlagen. Kein Ausrollen ohne Freigabe."
      }
    },
    {
      "id": "v-demo-2",
      "kunde_name": "Thesen AG",
      "quelle_json": {
        "kanal": "mail",
        "absender": "kontakt@example.org",
        "betreff": "Angebot Wartungsvertrag",
        "body_clean": "Wir möchten ein Angebot für einen Wartungsvertrag über zwölf Monate. Bitte mit Reaktionszeiten und einer Option auf Rufbereitschaft am Wochenende."
      },
      "triage_json": {
        "einordnung": "arbeit",
        "aufwand": "S",
        "antwort_vorschlag": "Gern — wir senden Ihnen bis morgen ein Angebot über zwölf Monate inklusive Reaktionszeiten und einer Option auf Rufbereitschaft.",
        "aufgabe": {
          "agent": "Sol · Completion",
          "beschreibung": "Angebot Wartungsvertrag über 12 Monate erstellen, Reaktionszeiten und Option Rufbereitschaft ausweisen."
        },
        "zusammenfassung": "Thesen AG möchte ein Angebot für einen Wartungsvertrag über zwölf Monate, mit Reaktionszeiten und Rufbereitschaft am Wochenende.",
        "antwort_kurz": "Angebot bis morgen zusagen.",
        "aufgabe_kurz": "Angebot über 12 Monate erstellen, Reaktionszeiten und Rufbereitschaft ausweisen."
      }
    },
    {
      "id": "v-demo-3",
      "kunde_name": "Nordwind",
      "quelle_json": {
        "kanal": "chat",
        "absender": "info@example.org",
        "betreff": "Rückfrage Rechnung",
        "body_clean": "Auf der letzten Rechnung fehlt die Bestellnummer. Können Sie eine korrigierte Rechnung schicken?"
      },
      "triage_json": {
        "zusammenfassung": "Nordwind fehlt die Bestellnummer auf der letzten Rechnung und bittet um eine korrigierte Fassung."
      }
    }
  ],
  "decisions": [
    {
      "id": "d-demo-1",
      "vorgang_id": "v-demo-1",
      "typ": "triage",
      "titel": "REM Capital",
      "status": "offen",
      "zeilen_json": [
        "Kurzfassung REM Capital"
      ],
      "detail_seiten_json": [
        {
          "titel": "AUDIT",
          "zeilen": [
            "eingegangen · 06:52 · mail",
            "triagiert · Sol · Completion",
            "Aufwand M · Vertrauen mittel"
          ]
        }
      ]
    },
    {
      "id": "d-demo-2",
      "vorgang_id": "v-demo-2",
      "typ": "triage",
      "titel": "Thesen AG",
      "status": "offen",
      "zeilen_json": [
        "Kurzfassung Thesen AG"
      ],
      "detail_seiten_json": []
    },
    {
      "id": "d-demo-3",
      "vorgang_id": "v-demo-3",
      "typ": "zuordnung",
      "titel": "Nordwind",
      "status": "offen",
      "zeilen_json": [
        "Kurzfassung Nordwind"
      ],
      "detail_seiten_json": []
    }
  ]
};

export function createSource(config = {}) {
  const { endpoint = null, token = null, live = false, fetchImpl = globalThis.fetch } = config;

  // Ohne `live` gibt es keinen Endpunkt — die Demo kann physisch nichts
  // versenden, statt sich nur zu merken, dass sie es nicht soll.
  if (!endpoint || !live) {
    const beantwortet = new Map();
    return {
      kind: "fixture",
      async load() {
        // Beantwortete Demo-Vorgaenge verschwinden, damit sich der Ablauf
        // anfuehlt wie im Betrieb.
        return {
          vorgaenge: FIXTURE.vorgaenge,
          decisions: FIXTURE.decisions.filter((d) => !beantwortet.has(d.id)),
        };
      },
      async answer(payload) {
        // Demo: nur vermerken. Kein Versand, keine Delegation, kein Kontakt
        // zur Instanz — dieser Zweig kennt den Endpunkt gar nicht.
        beantwortet.set(payload.decision?.id, payload.wert);
        console.info("[decision-hub] Demo — nicht gesendet:", payload.wert, payload.decision?.id);
      },
    };
  }

  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return {
    kind: "instance",
    async load() {
      const response = await fetchImpl(`${endpoint}/api/business-os/kundenpipeline/cards`, {
        headers,
      });
      if (!response.ok) throw new Error(`load failed: ${response.status}`);
      return response.json();
    },
    async answer({ decision, wert }) {
      const response = await fetchImpl(`${endpoint}/api/business-os/kundenpipeline/answer`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          entscheidung_id: decision.id,
          vorgang_id: decision.vorgang_id,
          wert,
          kanal: "brille",
        }),
      });
      if (!response.ok) throw new Error(`answer failed: ${response.status}`);
      return response.json();
    },
  };
}
