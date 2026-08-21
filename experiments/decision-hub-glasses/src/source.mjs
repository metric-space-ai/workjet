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
        "absender": "jill.cakmak@example.org",
        "betreff": "API-Key funktioniert nicht mehr",
        "body_clean": "Guten Morgen, seit heute früh meldet unser Portal beim Login einen CORS-Fehler."
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
      ]
    }
  ]
};

export function createSource(config = {}) {
  const { endpoint = null, token = null, fetchImpl = globalThis.fetch } = config;

  if (!endpoint) {
    return {
      kind: 'fixture',
      async load() {
        return FIXTURE;
      },
      async answer(payload) {
        console.info('[decision-hub] fixture answer', payload.wert, payload.decision?.id);
      },
    };
  }

  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return {
    kind: 'instance',
    async load() {
      const response = await fetchImpl(`${endpoint}/api/business-os/kundenpipeline/cards`, { headers });
      if (!response.ok) throw new Error(`load failed: ${response.status}`);
      return response.json();
    },
    async answer({ decision, wert }) {
      const response = await fetchImpl(`${endpoint}/api/business-os/kundenpipeline/answer`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ entscheidung_id: decision.id, vorgang_id: decision.vorgang_id, wert, kanal: 'brille' }),
      });
      if (!response.ok) throw new Error(`answer failed: ${response.status}`);
      return response.json();
    },
  };
}
