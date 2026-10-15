// Workjet fork delta: data contracts for the business scenes used in Jour fixe decks.
// The learnordie scenes (`modell.*`) are fixed lecture visualisations and carry no data;
// business scenes always render caller-supplied, bounded numbers.
import "../zod-config.ts";
import { z } from "zod";

export const businessSceneIdValues = ["business.kpi-bars", "business.trend"] as const;
export type BusinessSceneId = (typeof businessSceneIdValues)[number];

/** Serialized `data` of one scene3d block or canvas embed may not exceed this many UTF-8 bytes. */
export const BUSINESS_SCENE_DATA_MAX_BYTES = 16 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const unit = z.string().trim().min(1).max(16);
const finite = z.number().refine(Number.isFinite, "Use a finite number.");

/**
 * KPI comparison: one bar per KPI, current value against the value at the previous
 * Regeltermin. `better` says which direction counts as an improvement (default "higher").
 */
export const kpiBarsDataSchema = z
  .object({
    unit: unit.optional(),
    items: z
      .array(
        z
          .object({
            label: text(48),
            value: finite,
            previous: finite.optional(),
            unit: unit.optional(),
            better: z.enum(["higher", "lower"]).optional()
          })
          .strict()
      )
      .min(1)
      .max(8)
  })
  .strict();

/** One value over time, for example the five-year exit value per Regeltermin. */
export const trendDataSchema = z
  .object({
    label: text(80),
    unit: unit.optional(),
    target: finite.optional(),
    points: z
      .array(z.object({ label: text(24), value: finite }).strict())
      .min(2)
      .max(24)
  })
  .strict();

export type KpiBarsData = z.infer<typeof kpiBarsDataSchema>;
export type TrendData = z.infer<typeof trendDataSchema>;

export const businessSceneDataSchemas = {
  "business.kpi-bars": kpiBarsDataSchema,
  "business.trend": trendDataSchema
} as const satisfies Record<BusinessSceneId, z.ZodType>;

export type BusinessSceneData = {
  "business.kpi-bars": KpiBarsData;
  "business.trend": TrendData;
};

export function isBusinessSceneId(sceneId: string): sceneId is BusinessSceneId {
  return (businessSceneIdValues as readonly string[]).includes(sceneId);
}
