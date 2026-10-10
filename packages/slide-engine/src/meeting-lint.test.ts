import { describe, expect, it } from "vite-plus/test";

import { canvasSceneForSlide } from "./excalidraw/scene";
import { jourFixeDeck } from "./fixtures/jour-fixe-deck";
import { lintMeetingDeck, NARRATION_MAX_CHARS } from "./meeting-lint";
import type { SlideBlock, SlideDocument, SlideNode } from "./schema";
import { handleValidatorRequest } from "./validator/protocol";

const source = [{ id: "src-1", sourceType: "manual" as const, label: "Meeting-Daten" }];

const SPOKEN = "Das ist der wichtigste Punkt für die Entscheidung heute.";

function slide(
  id: string,
  title: string,
  blocks: SlideBlock[],
  notes: string[] = [SPOKEN],
): SlideNode {
  return {
    id,
    title,
    layout: "technical_one_column",
    intent: "summary",
    blocks,
    sourceRefs: source,
    speakerNotes: notes.map((text, index) => ({
      id: `${id}-n${index}`,
      kind: "talkingPoint",
      text,
    })),
  } as SlideNode;
}

const deck = (slides: SlideNode[]): SlideDocument => ({ ...jourFixeDeck, slides });
const codes = (document: SlideDocument) => lintMeetingDeck(document).map((issue) => issue.code);

describe("lintMeetingDeck", () => {
  it("accepts the example meeting deck without a finding", () => {
    expect(lintMeetingDeck(jourFixeDeck)).toEqual([]);
  });

  it("flags headings that repeat or merely extend the slide title", () => {
    const issues = lintMeetingDeck(
      deck([
        slide("s-title", "Regeltermin I-hate-AI.community – 09.10.2026", [
          { id: "h1", type: "heading", text: "Regeltermin I-hate-AI.community", level: 1 },
        ]),
        slide("s-next", "Nächste Schritte bis 16.10.", [
          { id: "h2", type: "heading", text: "Nächste Schritte bis 16.10.2026", level: 2 },
          { id: "h3", type: "heading", text: "Offen bei Marketing", level: 3 },
        ]),
      ]),
    );
    expect(issues.map((issue) => [issue.code, issue.blockId])).toEqual([
      ["content.title_repeated", "h1"],
      ["content.title_repeated", "h2"],
    ]);
    expect(issues[0]).toMatchObject({ severity: "error", slideId: "s-title" });
  });

  it("flags slides and tables that only say the evidence is missing", () => {
    const found = codes(
      deck([
        slide("s-title", "Regeltermin dommify.dev", [
          { id: "p", type: "paragraph", text: "Erster Termin." },
        ]),
        slide("s-kpis", "KPIs: keine Daten", [
          { id: "p2", type: "paragraph", text: "Noch nichts." },
        ]),
        slide("s-prs", "Gemergte PRs", [
          {
            id: "t",
            type: "table",
            mobileStrategy: "stack",
            columns: ["PR", "Titel"],
            rows: [["—", "keine Daten"]],
          },
        ]),
      ]),
    );
    expect(found).toEqual(["content.empty_slide", "content.placeholder_table"]);
  });

  it("flags wording about the slide, the display, the plumbing and the author", () => {
    const phrases = [
      "Die Trenddarstellung bleibt deshalb bewusst leer.",
      "Sobald ein Zielwert E5 erfasst wird, erscheint er hier mit Verlauf.",
      "Links steht der Soll-Zustand.",
      "GitHub-Metrik-Adapter fehlt laut Katalog.",
      "Belegt aus der Projekt-Konfiguration.",
      "Ich erfinde keine Werte.",
      "Konkrete Vorschläge folgen am Ende des Termins.",
      "Damit beim nächsten Termin alle Folien echte Werte zeigen.",
      "Diese Folie fasst den Stand zusammen.",
    ];
    const issues = lintMeetingDeck(
      deck(
        phrases.map((text, index) =>
          slide(`s${index}`, `Thema ${index}`, [{ id: `p${index}`, type: "paragraph", text }]),
        ),
      ),
    );
    expect(issues.map((issue) => [issue.code, issue.slideId])).toEqual(
      phrases.map((_, index) => ["content.meta_phrase", `s${index}`]),
    );
  });

  it("flags internal ids and system terms in visible text and speaker notes", () => {
    const issues = lintMeetingDeck(
      deck([
        slide(
          "s-kpis",
          "Kennzahlen",
          [
            {
              id: "b",
              type: "bulletList",
              items: ["Gemergte PRs: missing_source", "project_tasks_total: 4"],
            },
            {
              id: "c",
              type: "callout",
              tone: "key",
              title: "Datenquellen",
              text: "KPI-Prompts an die Task-Rezepte binden.",
            },
          ],
          ["Die Werte sind noch nicht gebunden."],
        ),
      ]),
    );
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["content.system_jargon", "$.slides[0].blocks[0].items[0]"],
      ["content.system_jargon", "$.slides[0].blocks[0].items[1]"],
      ["content.system_jargon", "$.slides[0].blocks[1].text"],
      ["content.system_jargon", "$.slides[0].speakerNotes[0].text"],
    ]);
  });

  it("keeps ordinary project language", () => {
    expect(
      lintMeetingDeck(
        deck([
          slide("s-title", "Regeltermin Verpackung", [
            {
              id: "p",
              type: "paragraph",
              text: "Die Folie aus recyceltem PET spart 12 % Material.",
            },
            {
              id: "q",
              type: "bulletList",
              items: [
                "Der Produktkatalog wächst auf 240 Artikel.",
                "Hier fehlt noch die Freigabe der Druckerei.",
              ],
            },
          ]),
        ]),
      ),
    ).toEqual([]);
  });

  it("warns once when the same sentence stands on two slides", () => {
    const sentence = "Ziel für den nächsten Regeltermin mit messbarem Abschluss festlegen.";
    const issues = lintMeetingDeck(
      deck([
        slide("s-decisions", "Entscheidungen", [{ id: "a", type: "paragraph", text: sentence }]),
        slide("s-next", "Nächste Schritte", [{ id: "b", type: "numberedList", items: [sentence] }]),
      ]),
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "content.duplicate_text",
        severity: "warning",
        slideId: "s-next",
      }),
    ]);
  });

  it("reads canvas text when the slide has a canvas", () => {
    const base = jourFixeDeck.slides[1]!;
    const canvas = canvasSceneForSlide(base, jourFixeDeck.assets);
    const textIndex = canvas.elements.findIndex(
      (element) => element.type === "text" && element.id !== `${base.id}:title`,
    );
    const elements = canvas.elements.map((element, index) =>
      index === textIndex
        ? {
            ...element,
            text: "Diese Folie zeigt nichts.",
            originalText: "Diese Folie zeigt nichts.",
          }
        : element,
    );
    const found = lintMeetingDeck(
      deck([jourFixeDeck.slides[0]!, { ...base, canvas: { ...canvas, elements } }]),
    );
    expect(found).toEqual([
      expect.objectContaining({
        code: "content.meta_phrase",
        path: `$.slides[1].canvas.elements[${textIndex}].text`,
      }),
    ]);
  });

  it("answers the lintMeeting validator op", () => {
    const clean = handleValidatorRequest({ op: "lintMeeting", document: jourFixeDeck });
    expect(clean).toEqual({ exitCode: 0, response: { ok: true, issues: [], warnings: [] } });
    const slop = handleValidatorRequest({
      op: "lintMeeting",
      document: deck([
        jourFixeDeck.slides[0]!,
        slide("s-kpis", "KPIs: keine Daten", [{ id: "p", type: "paragraph", text: "Leer." }]),
      ]),
    });
    expect(slop).toMatchObject({
      exitCode: 0,
      response: {
        ok: false,
        issues: [expect.objectContaining({ code: "content.empty_slide" })],
        warnings: [],
      },
    });
  });

  it("requires a talking point and keeps it within the time budget", () => {
    const long = `${"Der Umsatz wächst, weil der Vertrieb neue Kunden gewinnt. ".repeat(9)}`;
    const found = lintMeetingDeck(
      deck([
        slide(
          "s-title",
          "Regeltermin",
          [{ id: "p", type: "paragraph", text: "Erster Termin." }],
          [
            "Willkommen zum Regeltermin. Heute klären wir das Ziel bis zum nächsten Termin und wer es misst, damit wir danach ohne Umwege weiterarbeiten können, auch wenn die Woche voll ist.",
          ],
        ),
        slide("s-a", "Umsatz", [{ id: "q", type: "paragraph", text: "Umsatz wächst." }], []),
        slide("s-b", "Vertrieb", [{ id: "r", type: "paragraph", text: "Neue Kunden." }], [long]),
      ]),
    ).map((issue) => [issue.code, issue.slideId]);
    expect(found).toEqual([
      ["narration.too_long", "s-title"],
      ["narration.missing", "s-a"],
      ["narration.too_long", "s-b"],
    ]);
    expect(long.length).toBeGreaterThan(NARRATION_MAX_CHARS);
  });

  it("allows only numbers the slide or its sources show", () => {
    const kpi = (notes: string[]) =>
      deck([
        jourFixeDeck.slides[0]!,
        {
          ...jourFixeDeck.slides[1]!,
          speakerNotes: notes.map((text, index) => ({
            id: `n${index}`,
            kind: "talkingPoint" as const,
            text,
          })),
        },
      ]);
    // 18.400 and 16.900 come from the scene data, 8,9 from the change the scene shows.
    expect(
      lintMeetingDeck(kpi(["Der Umsatz stieg von 16.900 auf 18.400 Euro, also um 8,9 Prozent."])),
    ).toEqual([]);
    expect(lintMeetingDeck(kpi(["Der Umsatz stieg auf 19.500 Euro."]))).toEqual([
      expect.objectContaining({ code: "narration.unsupported_number", slideId: "kennzahlen" }),
    ]);
  });

  it("flags narration that reads a bullet aloud or talks about the slide", () => {
    const bullets = [
      {
        id: "b",
        type: "bulletList" as const,
        items: ["Die Preisstufe Team startet im November mit 49 Euro je Platz"],
      },
    ];
    expect(
      lintMeetingDeck(
        deck([
          slide("s-title", "Regeltermin", [{ id: "p", type: "paragraph", text: "Erster Termin." }]),
          slide("s-price", "Preisstufe", bullets, [
            "Die Preisstufe Team startet im November mit 49 Euro je Platz.",
          ]),
          slide(
            "s-next",
            "Ausblick",
            [{ id: "q", type: "paragraph", text: "Pilot läuft." }],
            ["Im Folgenden geht es um den Pilot."],
          ),
        ]),
      ).map((issue) => [issue.code, issue.slideId]),
    ).toEqual([
      ["content.meta_phrase", "s-next"],
      ["narration.reads_slide", "s-price"],
    ]);
  });

  it("does not lint source notes, which are not spoken", () => {
    const noted = slide("s-title", "Regeltermin", [
      { id: "p", type: "paragraph", text: "Erster Termin." },
    ]);
    noted.speakerNotes = [
      ...(noted.speakerNotes ?? []),
      { id: "src", kind: "source", text: "project_kpi read, missing_source" },
    ];
    expect(lintMeetingDeck(deck([noted]))).toEqual([]);
  });
});
