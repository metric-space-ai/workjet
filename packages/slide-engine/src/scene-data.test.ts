// @effect-diagnostics nodeBuiltinImport:off -- Reads the schema sources to prove the scene id list is not duplicated.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { canvasEmbedSchema, type CanvasElement } from "./excalidraw/canvas-schema";
import { canvasSceneForSlide, updateSlideCanvas } from "./excalidraw/scene";
import { jourFixeDeck } from "./fixtures/jour-fixe-deck";
import { businessSceneSummary, formatNumber, scene3dDataIssue } from "./scene-data";
import { businessSceneIdValues, BUSINESS_SCENE_DATA_MAX_BYTES } from "./scenes/business-data";
import {
  isModellSceneId,
  modellSceneIdValues,
  scene3dSceneIdValues,
  scene3dSceneKey,
} from "./scenes/scene-ids";
import {
  slideBlockSchema,
  slideLayoutBudgets,
  slideLayoutIdValues,
  SlideDocumentValidationError,
  validateSlideDocument,
  type SlideBlock,
  type SlideDocument,
  type SlideLayoutId,
} from "./schema";

type Scene3DBlock = Extract<SlideBlock, { type: "scene3d" }>;

const kpiData = {
  items: [
    { label: "Umsatz MRR", value: 18400, previous: 16900, unit: "€" },
    { label: "Offene Bugs", value: 9, previous: 14, better: "lower" },
  ],
};

function deckWith(
  block: Scene3DBlock,
  layout: SlideLayoutId = "technical_figure_right",
): SlideDocument {
  const deck = structuredClone(jourFixeDeck);
  deck.slides = [
    {
      id: "probe",
      title: "Probe",
      layout,
      intent: "summary",
      blocks: [{ id: "probe-text", type: "paragraph", text: "Kurzer Text." }, block],
      sourceRefs: [{ id: "probe-source", sourceType: "manual", label: "Test" }],
    },
  ];
  return deck;
}

const sceneBlock = (sceneId: Scene3DBlock["sceneId"], data?: unknown): Scene3DBlock => ({
  id: "probe-scene",
  type: "scene3d",
  sceneId,
  altText: "Szene",
  ...(data === undefined ? {} : { data }),
});

const sceneIdOptions = (schema: { shape: object }): string[] =>
  (schema.shape as { sceneId: { options: string[] } }).sceneId.options;

describe("scene ids", () => {
  it("is one list shared by scene3d blocks and canvas embeds", () => {
    expect(scene3dSceneIdValues).toEqual([...modellSceneIdValues, ...businessSceneIdValues]);
    const block = slideBlockSchema.options.find((option) => option.shape.type.value === "scene3d")!;
    const embed = canvasEmbedSchema.options.find(
      (option) => option.shape.type.value === "scene3d",
    )!;
    expect(sceneIdOptions(block)).toEqual([...scene3dSceneIdValues]);
    expect(sceneIdOptions(embed)).toEqual([...scene3dSceneIdValues]);
    for (const file of ["schema.ts", "excalidraw/canvas-schema.ts"]) {
      const source = NodeFS.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, `${file} must not hardcode scene ids`).not.toMatch(
        /"(?:modell|business)\.[a-z-]+"/,
      );
    }
  });

  it("maps modell ids explicitly and rejects business ids for the modell host", () => {
    expect(modellSceneIdValues.map(scene3dSceneKey)).toEqual([
      "morph",
      "miniature",
      "law",
      "limits",
      "runtime",
      "learning",
      "language",
      "transfer",
    ]);
    expect(isModellSceneId("modell.law")).toBe(true);
    for (const id of [...businessSceneIdValues, "modell.unknown", "constructor"]) {
      expect(isModellSceneId(id)).toBe(false);
      expect(() => scene3dSceneKey(id as never)).toThrow(/not a modell scene/);
    }
  });
});

describe("scene data rule", () => {
  it("requires data for business blocks", () => {
    const result = validateSlideDocument(deckWith(sceneBlock("business.kpi-bars")));
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "scene3d.missing_data",
        path: "$.slides[0].blocks[1].data",
        slideId: "probe",
        blockId: "probe-scene",
        repairHint: expect.stringContaining("business.kpi-bars"),
      }),
    ]);
  });

  it("rejects data on modell blocks", () => {
    const result = validateSlideDocument(deckWith(sceneBlock("modell.law", { items: [] })));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => [issue.code, issue.blockId])).toEqual([
      ["scene3d.unexpected_data", "probe-scene"],
    ]);
  });

  it("rejects kpi-bars with nine items, a bad trend and oversized data", () => {
    const nine = {
      items: Array.from({ length: 9 }, (_, index) => ({ label: `KPI ${index + 1}`, value: index })),
    };
    const oversized = {
      items: [{ label: "x", value: 1 }],
      padding: "x".repeat(BUSINESS_SCENE_DATA_MAX_BYTES),
    };
    for (const block of [
      sceneBlock("business.kpi-bars", nine),
      sceneBlock("business.trend", { label: "Exitwert", points: [{ label: "KW 1", value: 1 }] }),
      sceneBlock("business.kpi-bars", oversized),
    ]) {
      const result = validateSlideDocument(deckWith(block));
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toEqual(["scene3d.invalid_data"]);
    }
    expect(scene3dDataIssue("business.kpi-bars", oversized)?.message).toMatch(
      /bytes; the limit is 16384/,
    );
  });

  it("accepts business blocks in every layout that allows scene3d", () => {
    const layouts = slideLayoutIdValues.filter(
      (layout) => slideLayoutBudgets[layout].allowedBlockTypes?.includes("scene3d") ?? true,
    );
    expect(layouts).toEqual(
      expect.arrayContaining(["technical_figure_right", "technical_figure_left"]),
    );
    for (const layout of layouts) {
      const result = validateSlideDocument(
        deckWith(sceneBlock("business.kpi-bars", kpiData), layout),
      );
      expect(result.ok, layout).toBe(true);
      expect(result.issues, layout).toEqual([]);
    }
  });

  it("applies the same rule to canvas embeds", () => {
    const deck = structuredClone(jourFixeDeck);
    const canvasSlide = deck.slides.find((slide) => slide.canvas)!;
    const embed = canvasSlide.canvas!.elements.find((element) => element.type === "embeddable")!;
    const payload = embed.customData!.learnordie as { data?: unknown; sceneId: string };
    delete payload.data;
    const missing = validateSlideDocument(deck);
    expect(missing.issues).toEqual([
      expect.objectContaining({
        code: "scene3d.missing_data",
        slideId: canvasSlide.id,
        path: `$.slides[${deck.slides.indexOf(canvasSlide)}].canvas.elements[${canvasSlide.canvas!.elements.indexOf(embed)}].customData.learnordie.data`,
      }),
    ]);
    payload.sceneId = "modell.law";
    payload.data = { items: [] };
    expect(validateSlideDocument(deck).issues.map((issue) => issue.code)).toEqual([
      "scene3d.unexpected_data",
    ]);
  });
});

describe("canvas migration and updates", () => {
  it("carries block data into the embed", () => {
    const slide = jourFixeDeck.slides.find((candidate) => candidate.id === "kennzahlen")!;
    const block = slide.blocks.find((candidate) => candidate.type === "scene3d")!;
    const embed = canvasSceneForSlide(slide, jourFixeDeck.assets).elements.find(
      (element) => element.type === "embeddable",
    )!;
    expect(embed.customData).toEqual({
      sourceBlockId: block.id,
      learnordie: {
        type: "scene3d",
        sceneId: "business.kpi-bars",
        caption: "Kennzahlen gegen KW 39",
        data: block.data,
      },
    });
  });

  it("migrates every Jour fixe slide into a document that still validates", () => {
    let deck = jourFixeDeck;
    for (const slide of jourFixeDeck.slides)
      deck = updateSlideCanvas(deck, slide.id, canvasSceneForSlide(slide, deck.assets));
    expect(validateSlideDocument(deck).ok).toBe(true);
  });

  it("rejects an embed with invalid data", () => {
    const slide = jourFixeDeck.slides.find((candidate) => candidate.id === "kennzahlen")!;
    const scene = canvasSceneForSlide(slide, jourFixeDeck.assets);
    const embed = scene.elements.find((element) => element.type === "embeddable")! as CanvasElement;
    (embed.customData!.learnordie as { data: unknown }).data = {
      items: Array.from({ length: 9 }, (_, index) => ({ label: `K${index}`, value: index })),
    };
    let error: unknown;
    try {
      updateSlideCanvas(jourFixeDeck, slide.id, scene);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SlideDocumentValidationError);
    expect((error as SlideDocumentValidationError).issues).toEqual([
      expect.objectContaining({
        code: "scene3d.invalid_data",
        slideId: "kennzahlen",
        blockId: "kennzahlen-szene",
      }),
    ]);
  });
});

describe("business scene summary", () => {
  it("renders one KPI line with deltas", () => {
    expect(businessSceneSummary("business.kpi-bars", kpiData)).toBe(
      "KPI: Umsatz MRR 18.400 € (Δ +8,9 %) · Offene Bugs 9 (Δ -35,7 %)",
    );
    expect(
      businessSceneSummary(
        "business.trend",
        {
          label: "Exitwert E5",
          unit: "Mio €",
          points: [
            { label: "KW 39", value: 11 },
            { label: "KW 41", value: 11.6 },
          ],
        },
        "en",
      ),
    ).toBe("KPI: Exitwert E5 11.6 Mio € (Δ +5.5 %)");
    expect(businessSceneSummary("modell.law", undefined)).toBeUndefined();
    expect(businessSceneSummary("business.trend", { label: "x" })).toBeUndefined();
  });

  it("formats numbers without host locale data", () => {
    expect(formatNumber(1240)).toBe("1240");
    expect(formatNumber(-1234567.891)).toBe("-1.234.567,89");
    expect(formatNumber(1234567.5, "en")).toBe("1,234,567.5");
  });
});
