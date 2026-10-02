import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const ProjectWebsiteUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);
      return (
        ((url.protocol === "https:" || url.protocol === "http:") &&
          url.username === "" &&
          url.password === "" &&
          !/[\u0000-\u001f\u007f]/u.test(value)) ||
        "Use an absolute HTTP or HTTPS URL without credentials."
      );
    } catch {
      return "Use an absolute HTTP or HTTPS URL.";
    }
  }),
);
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(96));
export const ProjectOverviewSlot = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    label: Label,
    value: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({ kind: Schema.Literal("link"), label: Label, url: ProjectWebsiteUrl }),
  Schema.Struct({ kind: Schema.Literal("updated"), label: Label }),
  Schema.Struct({
    kind: Schema.Literal("metric"),
    label: Label,
    value: Schema.Number.check(
      Schema.makeFilter((value: number) => Number.isFinite(value) || "Enter a finite number."),
    ),
    unit: TrimmedString.check(Schema.isMaxLength(32)),
  }),
]);
export type ProjectOverviewSlot = typeof ProjectOverviewSlot.Type;
const OptionalSlot = Schema.NullOr(ProjectOverviewSlot);
export const ProjectOverview = Schema.Struct({
  websiteUrl: Schema.NullOr(ProjectWebsiteUrl),
  slots: Schema.Tuple([OptionalSlot, OptionalSlot, OptionalSlot]),
});
export type ProjectOverview = typeof ProjectOverview.Type;
