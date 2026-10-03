import { describe, expect, it } from "vite-plus/test";
import type * as AcpSchema from "effect-acp/schema";
import {
  MINIMAX_PREVIEW_MODEL,
  parseMiniMaxModelValue,
  resolveMiniMaxModelValue,
  miniMaxEffortValue,
  miniMaxModelsFromConfig,
} from "./MiniMaxProtocol.ts";
import { miniMaxElicitationForm } from "./MiniMaxElicitation.ts";
import { parseSessionUpdateEvent } from "../acp/AcpRuntimeModel.ts";

const model = MINIMAX_PREVIEW_MODEL;
const tokenRoute = `m:minimax_oauth:${model}:u`;
const apiRoute = `m:minimax_api:${model}:u`;
const options = (values: readonly string[] = [tokenRoute]): AcpSchema.SessionConfigOption[] => [
  {
    type: "select",
    id: "model",
    category: "model",
    name: "Model",
    currentValue: values[0]!,
    options: values.map((value) => ({ value, name: value })),
  },
  {
    type: "select",
    id: "thinkingEffort",
    category: "thought_level",
    name: "Thinking effort",
    currentValue: "medium",
    options: ["low", "medium", "high", "xhigh", "max", "none", "disabled"].map((value) => ({
      value,
      name: value,
    })),
  },
];

describe("MiniMax Code runtime selection", () => {
  it("preserves the exact model, provider and variant in the shipped encoding", () => {
    expect(parseMiniMaxModelValue(`m:custom%3Aroute:${model}:v:fast%3Amode`)).toMatchObject({
      providerId: "custom:route",
      modelId: model,
      variant: "fast:mode",
    });
    expect(parseMiniMaxModelValue("MiniMax-M3.1-Flash-Preview")).toBeUndefined();
    expect(parseMiniMaxModelValue("m:provider:%xx:u")).toBeUndefined();
  });
  it("rejects an unavailable model instead of substituting the configured default", () => {
    expect(() =>
      resolveMiniMaxModelValue(options(["m:minimax_oauth:MiniMax-M2.7:u"]), model),
    ).toThrow("does not advertise");
  });
  it("retains the current route and validates explicit routes against the selected model", () => {
    expect(resolveMiniMaxModelValue(options([tokenRoute, apiRoute]), model)).toBe(tokenRoute);
    expect(
      resolveMiniMaxModelValue(options([tokenRoute, apiRoute]), model, [
        { id: "providerRoute", value: apiRoute },
      ]),
    ).toBe(apiRoute);
    expect(() =>
      resolveMiniMaxModelValue(options(), model, [{ id: "providerRoute", value: apiRoute }]),
    ).toThrow("selected route");
  });
  it("keeps the native provider and variant when switching to another advertised model", () => {
    expect(
      resolveMiniMaxModelValue(
        options(["m:minimax_oauth:older-model:u", tokenRoute, apiRoute]),
        model,
      ),
    ).toBe(tokenRoute);
    const fastRoute = `m:minimax_oauth:${model}:v:fast`;
    expect(
      resolveMiniMaxModelValue(
        options(["m:minimax_oauth:older-model:v:fast", fastRoute, tokenRoute, apiRoute]),
        model,
      ),
    ).toBe(fastRoute);
    expect(() =>
      resolveMiniMaxModelValue(
        options(["m:minimax_oauth:older-model:v:other-variant", tokenRoute, apiRoute]),
        model,
      ),
    ).toThrow("Choose a MiniMax Code provider route");
  });
  it("requires a route when multiple non-current routes advertise a model", () => {
    expect(() =>
      resolveMiniMaxModelValue(options(["m:other:other-model:u", tokenRoute, apiRoute]), model),
    ).toThrow("Choose a MiniMax Code provider route");
  });
  it("never disables thinking or sends unadvertised effort", () => {
    for (const effort of ["none", "disabled", "ultra"])
      expect(() => miniMaxEffortValue(options(), model, [{ id: "effort", value: effort }])).toThrow(
        "does not advertise thinking effort",
      );
    for (const effort of ["low", "medium", "high", "xhigh", "max"])
      expect(miniMaxEffortValue(options(), model, [{ id: "effort", value: effort }])).toBe(effort);
    expect(miniMaxEffortValue(options(), model)).toBeUndefined();
    expect(
      miniMaxEffortValue(options(), model, [{ id: "effort", value: "automatic" }]),
    ).toBeUndefined();
    expect(() =>
      miniMaxEffortValue(options().slice(0, 1), model, [{ id: "effort", value: "high" }]),
    ).toThrow();
  });
  it("blocks disabled thinking for every model and omits invalid current effort", () => {
    const otherModel = "native-other-model";
    const advertised = options([`m:minimax_oauth:${otherModel}:u`]).map((option) =>
      option.type === "select" && option.id === "thinkingEffort"
        ? { ...option, currentValue: "none" }
        : option,
    );
    for (const effort of ["none", "disabled"])
      expect(() =>
        miniMaxEffortValue(advertised, otherModel, [{ id: "thinkingEffort", value: effort }]),
      ).toThrow("does not advertise thinking effort");
    const descriptor = miniMaxModelsFromConfig(advertised)[0]?.capabilities.optionDescriptors?.find(
      (entry) => entry.id === "thinkingEffort",
    );
    if (descriptor?.type === "select") {
      expect(descriptor.options.map((entry) => entry.id)).not.toContain("none");
      expect(descriptor.currentValue).toBeUndefined();
    } else throw new Error("Expected advertised thinking options");
  });
  it("publishes only runtime models and only advertised always-on thinking options", () => {
    expect(miniMaxModelsFromConfig([])).toEqual([]);
    const models = miniMaxModelsFromConfig(options([tokenRoute, apiRoute]));
    expect(models.map((entry) => entry.slug)).toEqual([model]);
    // The composer and saved Lumas apply reasoning through the primary select.
    expect(models[0]?.capabilities.optionDescriptors?.[0]?.id).toBe("thinkingEffort");
    const effort = models[0]?.capabilities.optionDescriptors?.find(
      (entry) => entry.id === "thinkingEffort",
    );
    expect(effort?.type).toBe("select");
    if (effort?.type === "select")
      expect(effort.options.map((entry) => entry.id)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
  });
  it("preserves optional ACP thought chunks and accepts ordinary output without thoughts", () => {
    expect(
      parseSessionUpdateEvent({
        sessionId: "s",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      }).events,
    ).toMatchObject([{ _tag: "ThoughtDelta", text: "thinking" }]);
    expect(
      parseSessionUpdateEvent({
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
      }).events,
    ).toMatchObject([{ _tag: "ContentDelta", text: "answer" }]);
  });
});

describe("MiniMax Code question forms", () => {
  const form = () =>
    miniMaxElicitationForm({
      mode: "form",
      message: "Choose a scope",
      requestedSchema: {
        type: "object",
        required: ["scope"],
        properties: {
          scope: {
            type: "string",
            title: "Scope",
            oneOf: [
              { const: "small", title: "Small change" },
              { const: "large", title: "Large change" },
            ],
          },
          tools: {
            type: "array",
            title: "Tools",
            items: {
              anyOf: [
                { const: "read", title: "Read" },
                { const: "edit", title: "Edit" },
              ],
            },
          },
          note: { type: "string", title: "Note" },
        },
      },
    });
  it("maps visible answers back to advertised enum IDs and retains free text", () => {
    expect(
      form().content({ scope: ["Small change"], tools: ["Read", "Edit"], note: ["keep tests"] }),
    ).toEqual({ scope: "small", tools: ["read", "edit"], note: "keep tests" });
    expect(form().questions.find((entry) => entry.id === "tools")?.multiSelect).toBe(true);
  });
  it("decodes the same enumNames labels shown for scalar and array choices", () => {
    const named = miniMaxElicitationForm({
      mode: "form",
      message: "Choose",
      requestedSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["small"], enumNames: ["Small"] },
          tools: { type: "array", items: { enum: ["read", "edit"], enumNames: ["Read", "Edit"] } },
        },
      },
    });
    expect(named.questions[0]?.options?.[0]?.label).toBe("Small");
    expect(named.questions[1]?.options?.map((entry) => entry.label)).toEqual(["Read", "Edit"]);
    expect(named.content({ scope: ["Small"], tools: ["Read", "Edit"] })).toEqual({
      scope: "small",
      tools: ["read", "edit"],
    });
  });
  it("rejects ambiguous labels while preserving exact native IDs", () => {
    const named = miniMaxElicitationForm({
      message: "Choose",
      requestedSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["small", "large"], enumNames: ["Same", "Same"] },
        },
      },
    });
    expect(() => named.content({ scope: ["Same"] })).toThrow("Ambiguous answer label");
    expect(named.content({ scope: ["small"] })).toEqual({ scope: "small" });
  });
  it("cancels empty responses and rejects missing required or unadvertised answers", () => {
    expect(form().content({})).toBeUndefined();
    expect(() => form().content({ note: ["hello"] })).toThrow("Answer required");
    expect(() => form().content({ scope: ["invented"] })).toThrow("Unadvertised answer");
  });
});
