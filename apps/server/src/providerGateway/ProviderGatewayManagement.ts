import type { WorkjetGatewayProvider, WorkjetGatewayProviderPhase } from "@t3tools/contracts";

/**
 * Decoders for the Rust host's management payloads.
 *
 * Every shape here is pinned to what the host actually serializes; nothing is
 * inferred or hoped for. The host's structs carry no `rename_all`, so the wire
 * keys are snake_case, and its `ManagementRuntimePhase` enum is snake_case too.
 * A payload that does not match decodes to `undefined` rather than to a partial
 * value, so the caller reports "unavailable" instead of showing a guess.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_TEXT = 160;
const MAX_MODELS = 256;
const MAX_PROVIDERS = 32;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT ? trimmed : undefined;
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000
    ? value
    : undefined;

const modelIds = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value) || value.length > MAX_MODELS) return undefined;
  const models = value.map(text);
  if (models.some((model) => model === undefined)) return undefined;
  return [...new Set(models as ReadonlyArray<string>)];
};

/**
 * The host's `ManagementRuntimePhase`, narrowed to the three states this
 * surface can say something honest about. Anything else — including a phase the
 * host adds later — becomes `unknown` rather than being mapped onto a
 * comfortable neighbour.
 */
export const runtimePhase = (value: unknown): WorkjetGatewayProviderPhase => {
  if (value === "ready") return "ready";
  if (value === "waiting_for_subscription") return "waiting-for-subscription";
  return "unknown";
};

export interface RuntimeStatusSnapshot {
  /** Phase of the provider (responses) endpoint; the host has no per-provider phase. */
  readonly providerPhase: WorkjetGatewayProviderPhase;
  readonly activeProvider: string | undefined;
}

export const decodeRuntimeStatus = (value: unknown): RuntimeStatusSnapshot | undefined => {
  if (!isRecord(value) || value.schema !== "workjet.provider-gateway.runtime-status.v1") {
    return undefined;
  }
  const endpoint = value.main_responses_gateway;
  if (!isRecord(endpoint)) return undefined;
  return {
    providerPhase: runtimePhase(endpoint.phase),
    activeProvider: text(value.active_provider),
  };
};

export interface RuntimeConfigProviderSummary {
  readonly provider: string;
  readonly accountCount: number;
  readonly enabledAccountCount: number;
  readonly modelIds: ReadonlyArray<string>;
}

export interface RuntimeConfigSnapshot {
  readonly defaultProvider: string | undefined;
  readonly providers: ReadonlyArray<RuntimeConfigProviderSummary>;
}

export const decodeRuntimeConfigSummary = (value: unknown): RuntimeConfigSnapshot | undefined => {
  if (
    !isRecord(value) ||
    value.schema !== "workjet.provider-gateway.runtime-summary.v1" ||
    !Array.isArray(value.providers) ||
    value.providers.length > MAX_PROVIDERS
  ) {
    return undefined;
  }
  const providers: Array<RuntimeConfigProviderSummary> = [];
  for (const entry of value.providers) {
    if (!isRecord(entry)) return undefined;
    const provider = text(entry.provider);
    const accountCount = count(entry.account_count);
    const enabledAccountCount = count(entry.enabled_account_count);
    const models = modelIds(entry.models);
    if (
      provider === undefined ||
      accountCount === undefined ||
      enabledAccountCount === undefined ||
      models === undefined
    ) {
      return undefined;
    }
    providers.push({ provider, accountCount, enabledAccountCount, modelIds: models });
  }
  return { defaultProvider: text(value.default_provider), providers };
};

/**
 * The host's model-definition channel for each gateway provider, or `null`
 * where the host has no catalog at all.
 *
 * The host's `models_for_channel` accepts claude, gemini, vertex, aistudio,
 * codex-free/team/plus/pro, kimi, antigravity and xai/grok. Neither `zai` nor
 * `minimax` is among them, so those two providers get no catalog and the
 * surface must say so rather than showing an empty list as if it meant "no
 * models". `codex` resolves to the pro channel; the host picks a plan-specific
 * channel internally, which this read route cannot ask for.
 */
export const GATEWAY_MODEL_CHANNELS: Readonly<Record<WorkjetGatewayProvider, string | null>> = {
  claude: "claude",
  codex: "codex",
  antigravity: "antigravity",
  kimi: "kimi",
  xai: "xai",
  zai: null,
  minimax: null,
};

export interface CatalogModel {
  readonly id: string;
  readonly displayName: string;
}

/**
 * `GET /v0/management/model-definitions/<channel>` answers
 * `{"channel": "...", "models": [ ...RegistryModelInfo ]}`. Only `id` is
 * guaranteed: `display_name` and `name` are both skipped when empty, so the id
 * is the fallback label.
 */
export const decodeModelDefinitions = (
  value: unknown,
  expectedChannel: string,
): ReadonlyArray<CatalogModel> | undefined => {
  if (!isRecord(value) || value.channel !== expectedChannel || !Array.isArray(value.models)) {
    return undefined;
  }
  const models: Array<CatalogModel> = [];
  const seen = new Set<string>();
  for (const entry of value.models.slice(0, MAX_MODELS)) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, displayName: text(entry.display_name) ?? text(entry.name) ?? id });
  }
  return models;
};
