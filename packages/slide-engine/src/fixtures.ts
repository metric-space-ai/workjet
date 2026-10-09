import {
  SLIDE_DOCUMENT_SCHEMA_VERSION,
  parseSlideDocument,
  type SlideDocument
} from "./schema";

const schematicSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Schematische Lagergrafik">
  <rect width="640" height="360" rx="28" fill="#d9e8ee"/>
  <path d="M94 250c70-110 154-113 252-28 72 62 143 57 203-68" fill="none" stroke="#2b82ad" stroke-width="16" stroke-linecap="round"/>
  <circle cx="300" cy="166" r="72" fill="#f7fafb" stroke="#36515c" stroke-width="12"/>
  <path d="M205 187c76 76 198 54 246-72" fill="none" stroke="#c28516" stroke-width="20" stroke-linecap="round"/>
  <line x1="92" y1="276" x2="550" y2="276" stroke="#6b818b" stroke-width="5"/>
</svg>
`);

export const allBlockTypesSlideDocument: SlideDocument = parseSlideDocument({
  schemaVersion: SLIDE_DOCUMENT_SCHEMA_VERSION,
  id: "qa-all-block-types",
  title: "Slide Engine QA: alle Blocktypen",
  language: "de",
  aspect: "16:9",
  theme: "learnordie-technical",
  deckSettings: {
    defaultTransition: "slide",
    showSlideNumbers: true,
    allowFragments: false,
    mobileMode: "hybrid"
  },
  assets: [
    {
      id: "asset-bearing-schematic",
      kind: "diagram",
      title: "Schematische Gleitlagergrafik",
      url: `data:image/svg+xml;charset=utf-8,${schematicSvg}`,
      altText: "Schematische Lagergrafik mit Welle, Schmierfilm und Verlaufskurve.",
      source: {
        id: "source-qa-manual",
        sourceType: "manual",
        label: "QA-Fixture"
      },
      quality: {
        needsReview: false
      }
    }
  ],
  slides: [
    {
      id: "blocks-text",
      title: "Text und Struktur",
      layout: "technical_one_column",
      intent: "definition",
      sourceRefs: [
        { id: "source-text", sourceType: "manual", label: "QA-Fixture Text" }
      ],
      blocks: [
        { id: "text-heading", type: "heading", text: "Text und Struktur", level: 1 },
        {
          id: "text-paragraph",
          type: "paragraph",
          text: "Agenten erzeugen diese Blöcke als strukturierte Folienbausteine, nicht als freies HTML."
        },
        { id: "text-subheading", type: "heading", text: "Adressierbare Bausteine", level: 2 },
        {
          id: "text-quiz-anchor",
          type: "quizAnchor",
          anchorId: "qa-anchor-text",
          level: "3.0",
          prompt: "Begriffe und Erklärung prüfen"
        },
        {
          id: "text-bullets",
          type: "bulletList",
          items: ["stabile Block-IDs", "prüfbare Quellen", "gezielte Repair-Hints"]
        },
        {
          id: "text-numbered",
          type: "numberedList",
          items: ["Quelle lesen", "Block wählen", "Layout prüfen"]
        },
        {
          id: "text-definition",
          type: "definition",
          term: "SlideDocument",
          definition: "Versionierter AST für Folien, Assets, Quellen, Notizen und Quizanker.",
          example: "Ein Agent ändert einen Block statt beliebiges DOM zu patchen."
        },
        {
          id: "text-callout",
          type: "callout",
          tone: "key",
          title: "Wichtig",
          text: "Alle sichtbaren Blöcke bleiben über data-block-id adressierbar."
        },
        { id: "text-spacer", type: "spacer", size: "small" }
      ]
    },
    {
      id: "blocks-media",
      title: "Medien und Daten",
      layout: "technical_two_column",
      intent: "explanation",
      sourceRefs: [
        { id: "source-media", sourceType: "manual", label: "QA-Fixture Medien" }
      ],
      blocks: [
        { id: "media-heading", type: "heading", text: "Medien und Daten", level: 1 },
        {
          id: "media-paragraph",
          type: "paragraph",
          text: "Figuren, Formeln, Tabellen und Charts teilen sich dieselbe kontrollierte Renderer-Pipeline."
        },
        {
          id: "media-figure",
          type: "figure",
          assetId: "asset-bearing-schematic",
          altText: "Schematische Gleitlagergrafik.",
          caption: "Diagramm als kontrolliertes Asset"
        },
        {
          id: "media-formula",
          type: "formula",
          latex: "S = \\frac{\\eta \\cdot n}{p} \\left(\\frac{r}{c}\\right)^2",
          caption: "Sommerfeldzahl als strukturierter Formelblock"
        },
        {
          id: "media-table",
          type: "table",
          caption: "Betriebsgrößen",
          columns: ["Größe", "Wirkung", "Signal"],
          rows: [
            ["Drehzahl", "Schmierfilm steigt", "positiv"],
            ["Last", "Film wird dünner", "kritisch"],
            ["Viskosität", "Tragfähigkeit steigt", "abhängig"]
          ],
          mobileStrategy: "stack"
        },
        {
          id: "media-chart",
          type: "chart",
          chartType: "bar",
          title: "Qualitative Filmstärke",
          data: {
            labels: ["Start", "Aufbau", "Betrieb"],
            values: [18, 62, 94]
          },
          caption: "Chartdaten bleiben strukturiert."
        }
      ]
    },
    {
      id: "blocks-reasoning",
      title: "Ablauf und Bewertung",
      layout: "case_study",
      intent: "example",
      sourceRefs: [
        { id: "source-reasoning", sourceType: "manual", label: "QA-Fixture Ablauf" }
      ],
      blocks: [
        { id: "reasoning-heading", type: "heading", text: "Ablauf und Bewertung", level: 1 },
        {
          id: "reasoning-process",
          type: "process",
          steps: [
            { id: "step-import", title: "Import", text: "Material wird extrahiert und als Asset referenziert." },
            { id: "step-compose", title: "Komposition", text: "Agent wählt Layout und Blocktypen." },
            { id: "step-repair", title: "Repair", text: "QA-Fehler verweisen auf Block-IDs." }
          ]
        },
        {
          id: "reasoning-comparison",
          type: "comparison",
          left: {
            title: "Freies HTML",
            body: "Schnell, aber schwer prüfbar.",
            items: ["XSS-Risiko", "schwache Repair-Ziele"]
          },
          right: {
            title: "SlideDocument",
            body: "Strukturiert und agentenfreundlich.",
            items: ["Schema-Validation", "gezielte DOM-Zuordnung"]
          }
        },
        {
          id: "reasoning-code",
          type: "code",
          language: "ts",
          code: "repair({ slideId, blockId, patch })",
          caption: "Repair-Loop adressiert Block statt DOM-String."
        },
        {
          id: "reasoning-quote",
          type: "quote",
          text: "Die fachliche Wahrheit der Slides ist ein versioniertes SlideDocument.",
          attribution: "learnordie Slide Engine Plan"
        }
      ]
    },
    {
      id: "blocks-interactive",
      title: "Nicht das Ding. Die Beziehung.",
      layout: "technical_figure_right",
      intent: "explanation",
      sourceRefs: [
        { id: "source-interactive", sourceType: "manual", label: "QA-Fixture interaktive Szene" }
      ],
      blocks: [
        {
          id: "interactive-paragraph",
          type: "paragraph",
          text: "Eine mathematische Beschreibung verknüpft Größen. Der Regler verändert die Steifigkeit k des idealisierten Oszillators."
        },
        {
          id: "interactive-scene",
          type: "scene3d",
          sceneId: "modell.law",
          altText: "Feder-Masse-Oszillator mit Zeitverlauf der Auslenkung x(t) bei einstellbarer Steifigkeit k.",
          caption: "Idealisierter linearer Oszillator · m · ẍ + k · x = 0"
        }
      ]
    }
  ],
  createdBy: {
    mode: "manual",
    promptVersion: "slide-engine-fixture-v1"
  }
});
