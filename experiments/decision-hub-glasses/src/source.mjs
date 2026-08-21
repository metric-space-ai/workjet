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
        "absender": "jill@example.org",
        "betreff": "API-Key funktioniert nicht",
        "body_clean": "Guten Morgen, seit heute früh meldet unser Portal beim Login einen CORS-Fehler und der API-Key wird abgelehnt. Bitte prüfen Sie die Konfiguration. Wir brauchen das bis Freitag."
      }
    },
    {
      "id": "v-demo-2",
      "kunde_name": "Thesen AG",
      "quelle_json": {
        "absender": "kontakt@example.org",
        "betreff": "Angebot Wartungsvertrag",
        "body_clean": "Wir möchten ein Angebot für einen Wartungsvertrag über zwölf Monate."
      }
    },
    {
      "id": "v-demo-3",
      "kunde_name": "Nordwind",
      "quelle_json": {
        "absender": "info@example.org",
        "betreff": "Rückfrage Rechnung",
        "body_clean": "Auf der letzten Rechnung fehlt die Bestellnummer."
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
        "» MAIL",
        "Guten Morgen, seit heute früh meldet unser Portal",
        "beim Login einen CORS-Fehler und der API-Key wird",
        "abgelehnt. Bitte prüfen Sie die Konfiguration.",
        "",
        "» ANTWORT-VORSCHLAG",
        "Danke für die Meldung. Wir prüfen die CORS- und",
        "Key-Konfiguration umgehend und melden uns heute",
        "mit einem Zwischenstand.",
        "",
        "» AUFGABE → Sol · Completion",
        "CORS-Header und API-Key-Ablauf im Kundenportal",
        "prüfen, Ursache benennen, Fix vorschlagen."
      ],
      "detail_seiten_json": [
        {
          "titel": "AUDIT",
          "zeilen": [
            "eingegangen · REM Capital",
            "triagiert · Sol"
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
        "» MAIL",
        "Wir möchten ein Angebot für einen Wartungsvertrag",
        "über zwölf Monate.",
        "",
        "» ANTWORT-VORSCHLAG",
        "Gern — wir senden Ihnen bis morgen ein Angebot.",
        ""
      ],
      "detail_seiten_json": [
        {
          "titel": "AUDIT",
          "zeilen": [
            "eingegangen · Thesen AG",
            "triagiert · Sol"
          ]
        }
      ]
    },
    {
      "id": "d-demo-3",
      "vorgang_id": "v-demo-3",
      "typ": "zuordnung",
      "titel": "Nordwind",
      "status": "offen",
      "zeilen_json": [
        "» MAIL",
        "Auf der letzten Rechnung fehlt die Bestellnummer.",
        "",
        "Routing-Vorschlag: Nordwind"
      ],
      "detail_seiten_json": [
        {
          "titel": "AUDIT",
          "zeilen": [
            "eingegangen · Nordwind",
            "triagiert · Sol"
          ]
        }
      ]
    }
  ]
};

export function createSource(config = {}) {
  const { endpoint = null, token = null, fetchImpl = globalThis.fetch } = config;

  if (!endpoint) {
    return {
      kind: "fixture",
      async load() {
        return FIXTURE;
      },
      async answer(payload) {
        console.info("[decision-hub] fixture answer", payload.wert, payload.decision?.id);
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
