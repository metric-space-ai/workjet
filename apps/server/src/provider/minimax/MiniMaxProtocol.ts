import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/schema";
import type { ProviderOptionSelections, ServerProviderModel } from "@workjet/contracts";
import { createModelCapabilities } from "@workjet/shared/model";
import { collectSessionConfigOptionValues } from "../acp/AcpRuntimeModel.ts";

export const MINIMAX_CODE_RELEASE = {
  version: "0.6.2",
  packageName: "@minimax-ai/code",
  tarball: "https://registry.npmjs.org/@minimax-ai/code/-/code-0.6.2.tgz",
  integrity: "sha512-nDmN8/B9UNjOJnxCM5vtJUfwqlzjkzEhL2rbY8X8aH/EadhxK43v7QJ4PUev3tEwTxcZzPm0G3zSD8cNAB4iAg==",
  sourceCommit: "564e9166d81f87b0b767b005e4779d4697b512be",
} as const;
export const MINIMAX_PREVIEW_MODEL = "MiniMax-M3.1-Flash-Preview";
export const MINIMAX_THINKING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const ModelConfigValue = Schema.String.check(Schema.isPattern(/^m:[^:]+:[^:]+:(?:u|v:[^:]*)$/));
const decodeModelValue = Schema.decodeUnknownOption(ModelConfigValue);

/** Decode the shipped mcode 0.6.2 model value, preserving model, route and variant. */
export function parseMiniMaxModelValue(value: unknown) {
  const decoded = decodeModelValue(value);
  if (decoded._tag === "None") return undefined;
  const [, provider, model, variantKind, variant] = decoded.value.split(":");
  try {
    return {
      value: decoded.value,
      providerId: decodeURIComponent(provider!),
      modelId: decodeURIComponent(model!),
      ...(variantKind === "v" ? { variant: decodeURIComponent(variant ?? "") } : {}),
    };
  } catch {
    return undefined;
  }
}

export function miniMaxModelChoices(options: readonly AcpSchema.SessionConfigOption[]) {
  const option = options.find((entry) => entry.category === "model" && entry.type === "select");
  if (!option) return [];
  return collectSessionConfigOptionValues(option).flatMap((value) => {
    const selection = parseMiniMaxModelValue(value);
    return selection ? [selection] : [];
  });
}

/** Resolve only advertised choices. Multiple routes require a declared route or the current one. */
export function resolveMiniMaxModelValue(
  options: readonly AcpSchema.SessionConfigOption[],
  model: string,
  selections?: ProviderOptionSelections,
): string {
  const matching = miniMaxModelChoices(options).filter((choice) => choice.modelId === model);
  const requestedRoute = selections?.find((entry) => entry.id === "providerRoute")?.value;
  if (requestedRoute !== undefined) {
    const selected = matching.find((choice) => choice.value === requestedRoute);
    if (!selected) throw new Error(`MiniMax Code does not advertise model ${model} on the selected route.`);
    return selected.value;
  }
  const currentValue = options.find((entry) => entry.category === "model")?.currentValue;
  const current = matching.find((choice) => choice.value === currentValue);
  if (current) return current.value;
  const nativeCurrent = parseMiniMaxModelValue(currentValue);
  const currentRoute = nativeCurrent
    ? matching.filter((choice) => choice.providerId === nativeCurrent.providerId && choice.variant === nativeCurrent.variant)
    : [];
  if (currentRoute.length === 1) return currentRoute[0]!.value;
  if (matching.length === 1) return matching[0]!.value;
  if (matching.length === 0) throw new Error(`MiniMax Code does not advertise model ${model} for this account and computer.`);
  throw new Error(`Choose a MiniMax Code provider route for model ${model}.`);
}

/** Reject forbidden selections before changing the session or its native model. */
export function miniMaxRequestedEffort(model: string, selections?: ProviderOptionSelections): string | undefined {
  const requested = selections?.find((entry) => entry.id === "thinkingEffort" || entry.id === "effort")?.value;
  if (requested === undefined || requested === "automatic") return undefined;
  if (typeof requested !== "string" || requested === "none" || requested === "disabled" ||
      (model === MINIMAX_PREVIEW_MODEL && !MINIMAX_THINKING_EFFORTS.some((effort) => effort === requested))) {
    throw new Error(`MiniMax Code does not advertise thinking effort ${String(requested)} for ${model}.`);
  }
  return requested;
}

export function miniMaxEffortValue(
  options: readonly AcpSchema.SessionConfigOption[],
  model: string,
  selections?: ProviderOptionSelections,
): string | undefined {
  const requested = miniMaxRequestedEffort(model, selections);
  if (requested === undefined) return undefined;
  const option = options.find((entry) => entry.id === "thinkingEffort");
  const allowed = option ? collectSessionConfigOptionValues(option) : [];
  if (!allowed.includes(requested)) throw new Error(`MiniMax Code does not advertise thinking effort ${requested} for ${model}.`);
  return requested;
}

export function miniMaxModelsFromConfig(options: readonly AcpSchema.SessionConfigOption[]): readonly ServerProviderModel[] {
  const choices = miniMaxModelChoices(options);
  const current = parseMiniMaxModelValue(options.find((option) => option.category === "model")?.currentValue);
  const effort = options.find((option) => option.id === "thinkingEffort");
  return [...new Set(choices.map((choice) => choice.modelId))].map((model) => {
    const routes = choices.filter((choice) => choice.modelId === model);
    const efforts = model === current?.modelId && effort
      ? collectSessionConfigOptionValues(effort).filter((value) => value !== "none" && value !== "disabled" && (model !== MINIMAX_PREVIEW_MODEL || MINIMAX_THINKING_EFFORTS.some((entry) => entry === value)))
      : [];
    return {
      slug: model,
      name: model,
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [
        ...(efforts.length ? [{ id: "thinkingEffort", label: "Thinking effort", type: "select" as const, options: efforts.map((value) => ({ id: value, label: value })), ...(typeof effort?.currentValue === "string" && efforts.includes(effort.currentValue) ? { currentValue: effort.currentValue } : {}) }] : []),
        { id: "providerRoute", label: "Provider route", type: "select", options: routes.map((route) => ({ id: route.value, label: route.providerId + (route.variant === undefined ? "" : ` · ${route.variant}`) })), ...(current?.modelId === model ? { currentValue: current.value } : {}) },
      ] }),
    };
  });
}
