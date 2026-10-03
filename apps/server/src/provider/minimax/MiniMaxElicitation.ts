import * as Schema from "effect/Schema";
import type { UserInputQuestion, ProviderUserInputAnswers } from "@workjet/contracts";

const Choice = Schema.Struct({ const: Schema.String, title: Schema.optional(Schema.String) });
const Property = Schema.Struct({
  type: Schema.Literals(["string", "array", "boolean", "number", "integer"]),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enum: Schema.optional(Schema.Array(Schema.String)),
  enumNames: Schema.optional(Schema.Array(Schema.String)),
  oneOf: Schema.optional(Schema.Array(Choice)),
  items: Schema.optional(Schema.Struct({ anyOf: Schema.optional(Schema.Array(Choice)), enum: Schema.optional(Schema.Array(Schema.String)), enumNames: Schema.optional(Schema.Array(Schema.String)) })),
});
const Form = Schema.Struct({
  mode: Schema.optional(Schema.Literal("form")),
  message: Schema.String,
  requestedSchema: Schema.Struct({ type: Schema.Literal("object"), properties: Schema.Record(Schema.String, Property), required: Schema.optional(Schema.Array(Schema.String)) }),
});
const decodeForm = Schema.decodeUnknownSync(Form);

function propertyChoices(property: typeof Property.Type) {
  const names = property.enumNames ?? property.items?.enumNames;
  return property.oneOf ?? property.items?.anyOf ??
    (property.enum ?? property.items?.enum ?? []).map((entry, index) => ({ const: entry, title: names?.[index] }));
}

/** Translate mcode's advertised form, retaining enum ids behind visible labels. */
export function miniMaxElicitationForm(value: unknown) {
  const form = decodeForm(value);
  const questions: UserInputQuestion[] = Object.entries(form.requestedSchema.properties).map(([id, property]) => {
    const choices = propertyChoices(property);
    return { id, header: property.title || id, question: property.title || form.message, multiSelect: property.type === "array", options: choices.map((choice) => ({ label: choice.title || choice.const, description: property.description || choice.title || choice.const })) };
  });
  return {
    questions,
    content(answers: ProviderUserInputAnswers): Record<string, string | number | boolean | readonly string[]> | undefined {
      if (Object.keys(answers).length === 0) return undefined;
      const content: Record<string, string | number | boolean | readonly string[]> = {};
      for (const [id, property] of Object.entries(form.requestedSchema.properties)) {
        const answer = answers[id];
        if (answer === undefined) {
          if (form.requestedSchema.required?.includes(id)) throw new Error(`Answer required for ${id}.`);
          continue;
        }
        const choices = propertyChoices(property);
        const resolve = (input: string) => {
          const exact = choices.find((entry) => entry.const === input);
          if (exact) return exact.const;
          const named = choices.filter((entry) => entry.title === input);
          if (named.length > 1) throw new Error(`Ambiguous answer label for ${id}.`);
          if (choices.length && named.length === 0) throw new Error(`Unadvertised answer for ${id}.`);
          return named[0]?.const ?? input;
        };
        // Workjet's question UI supplies a list even for single-choice/free-text fields.
        const values = Array.isArray(answer) ? answer : [answer];
        if (!values.every((entry): entry is string => typeof entry === "string")) throw new Error(`Unsupported answer for ${id}.`);
        if (property.type === "array") content[id] = values.map(resolve);
        else if (property.type === "string" && values.length === 1) content[id] = resolve(values[0]!);
        else if (property.type === "boolean" && values.length === 1 && ["true", "false"].includes(values[0]!)) content[id] = values[0] === "true";
        else if ((property.type === "number" || property.type === "integer") && values.length === 1 && values[0]!.trim() && Number.isFinite(Number(values[0])) && (property.type !== "integer" || Number.isInteger(Number(values[0])))) content[id] = Number(values[0]);
        else throw new Error(`Unsupported answer for ${id}.`);
      }
      return content;
    },
  };
}
