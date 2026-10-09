import { describe, expect, it } from "vite-plus/test";

import { jourFixeDeck } from "./fixtures/jour-fixe-deck";
import {
  MEETING_SLIDE_TEXT_MAX_BYTES,
  meetingSlides,
  plainText,
  slideDocumentOutline,
  truncateUtf8,
} from "./meeting";
import type { SlideDocument } from "./schema";

const bytes = (value: string) => new TextEncoder().encode(value).length;

describe("meetingSlides", () => {
  const slides = meetingSlides(jourFixeDeck);
  const byId = Object.fromEntries(slides.map((slide) => [slide.id, slide]));

  it("projects every slide in order with bounded, non-empty text", () => {
    expect(slides.map((slide) => [slide.position, slide.id])).toEqual([
      [1, "titel"],
      [2, "kennzahlen"],
      [3, "exitwert"],
      [4, "offene-punkte"],
      [5, "entscheidung"],
    ]);
    for (const slide of slides) {
      expect(slide.title.length).toBeLessThanOrEqual(256);
      expect(slide.body_markdown.trim()).not.toBe("");
      expect(slide.narration.trim()).not.toBe("");
      expect(bytes(slide.body_markdown)).toBeLessThanOrEqual(MEETING_SLIDE_TEXT_MAX_BYTES);
      expect(bytes(slide.narration)).toBeLessThanOrEqual(MEETING_SLIDE_TEXT_MAX_BYTES);
    }
  });

  it("renders blocks as markdown with one KPI line per scene", () => {
    expect(byId.titel!.body_markdown).toBe(
      "Regeltermin am 8. Oktober 2026 · Stand seit dem 24. September",
    );
    expect(byId.kennzahlen!.body_markdown).toBe(
      [
        "Umsatz und Durchsatz steigen, die Zahl offener Bugs sinkt. Die aktiven Nutzer gehen leicht zurück.",
        "KPI: Umsatz MRR 18.400 € (Δ +8,9 %) · Aktive Nutzer 1240 (Δ -5,3 %) · Gemergte PRs 23 (Δ +35,3 %) · Offene Bugs 9 (Δ -35,7 %)",
      ].join("\n\n"),
    );
    expect(byId.exitwert!.body_markdown).toBe(
      "KPI: Exitwert E5 11,6 Mio € (Δ +5,5 %)\n\n- Ziel: 12 Mio € bis Jahresende\n- Treiber: wiederkehrender Umsatz und Marge",
    );
    expect(byId["offene-punkte"]!.body_markdown).toBe(
      [
        "- Release 0.4 an zwei Pilotkunden ausrollen\n- Preisseite überarbeiten\n- Onboarding-Mail für neue Teams testen",
        "> **Risiko** Der Zahlungsanbieter stellt seine API zum 1. Dezember um.",
      ].join("\n\n"),
    );
  });

  it("reads canvas slides from their native text and embeds", () => {
    expect(byId.entscheidung!.body_markdown).toBe(
      [
        "Vorschlag: Team-Stufe für 49 € je Platz und Monat ab November.",
        "- A: 49 € je Platz\n- B: 39 € je Platz mit Mindestabnahme",
        "KPI: Option A 14.700 € · Option B 13.260 €",
        "Handnotiz: bevorzugt A, wenn der Pilot bis KW 44 zahlt.",
      ].join("\n\n"),
    );
  });

  it("narrates talking points, or the body as plain text", () => {
    expect(byId["offene-punkte"]!.narration).toBe(
      "Release 0.4 ist fertig getestet; es fehlt nur das Go für die Pilotkunden.\n\nFür die API-Umstellung plane ich zwei Tage im November ein.",
    );
    expect(byId.exitwert!.narration).toBe(
      "KPI: Exitwert E5 11,6 Mio € (Δ +5,5 %)\n\nZiel: 12 Mio € bis Jahresende\nTreiber: wiederkehrender Umsatz und Marge",
    );
  });

  it("renders tables as markdown tables and truncates long bodies on a character boundary", () => {
    const deck: SlideDocument = structuredClone(jourFixeDeck);
    deck.slides = [
      {
        id: "tabelle",
        title: "Tabelle",
        layout: "table_focus",
        intent: "summary",
        blocks: [
          {
            id: "t",
            type: "table",
            caption: "Budget",
            columns: ["Posten", "Plan | Ist"],
            rows: [["Cloud", "1.200 €"], ["Lizenzen"]],
            mobileStrategy: "scroll",
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `p${index}`,
            type: "paragraph" as const,
            text: "Größe ä ö ü 💶 ".repeat(70).trim(),
          })),
        ],
        sourceRefs: [{ id: "s", sourceType: "manual", label: "Test" }],
      },
    ];
    const [slide] = meetingSlides(deck);
    expect(
      slide!.body_markdown.startsWith(
        "Budget\n\n| Posten | Plan \\| Ist |\n| --- | --- |\n| Cloud | 1.200 € |\n| Lizenzen |   |",
      ),
    ).toBe(true);
    expect(bytes(slide!.body_markdown)).toBeLessThanOrEqual(MEETING_SLIDE_TEXT_MAX_BYTES);
    expect(slide!.body_markdown.endsWith("…")).toBe(true);
    expect(slide!.body_markdown).not.toContain("�");
    expect(plainText("| Posten | Plan \\| Ist |\n| --- | --- |")).toBe("Posten, Plan | Ist");
  });

  it("falls back to the title when a slide has no readable text", () => {
    const deck: SlideDocument = structuredClone(jourFixeDeck);
    deck.slides = [
      {
        id: "leer",
        title: "Nur Titel",
        layout: "title_statement",
        intent: "title",
        blocks: [{ id: "spacer", type: "spacer", size: "small" }],
        sourceRefs: [{ id: "s", sourceType: "manual", label: "Test" }],
      },
    ];
    expect(meetingSlides(deck)).toEqual([
      {
        id: "leer",
        position: 1,
        title: "Nur Titel",
        body_markdown: "Nur Titel",
        narration: "Nur Titel",
      },
    ]);
  });

  it("truncates to the byte budget without splitting a multi-byte character", () => {
    expect(truncateUtf8("€€€", 7)).toBe("€…");
    expect(truncateUtf8("abc", 3)).toBe("abc");
  });
});

describe("slideDocumentOutline", () => {
  it("summarises structure for agents", () => {
    const outline = slideDocumentOutline(jourFixeDeck);
    expect(outline).toMatchObject({
      id: "jour-fixe-2026-kw41",
      language: "de",
      theme: "learnordie-north",
    });
    expect(outline.slides[1]).toEqual({
      id: "kennzahlen",
      title: "Kennzahlen seit dem letzten Regeltermin",
      layout: "technical_figure_right",
      intent: "summary",
      hasCanvas: false,
      blockTypes: ["paragraph", "scene3d"],
      scenes: [{ sceneId: "business.kpi-bars", hasData: true }],
      speakerNotes: 1,
      sourceRefs: 1,
    });
    expect(outline.slides[4]).toMatchObject({
      hasCanvas: true,
      scenes: [{ sceneId: "business.kpi-bars", hasData: true }],
    });
  });
});
