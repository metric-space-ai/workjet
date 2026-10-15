import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetNativeAccountReference } from "./workjet.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
);
const Revision = Counter.check(Schema.isGreaterThanOrEqualTo(1));
const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const Models = Schema.Array(Id).check(Schema.isMaxLength(256));
const CatalogModels = Schema.Array(Id).check(Schema.isMaxLength(1024));
const base = { version: Schema.Literal(1), operationId: Uuid };
export const WorkjetNativeModelProbe = Schema.Struct({
  modelId: Id,
  checkedAtMs: Revision,
  elapsedMs: Counter,
  status: Schema.Literals(["ok", "failed", "unavailable"]),
  source: Schema.Literals(["gateway", "upstream"]),
  failure: Schema.NullOr(
    Schema.Literals([
      "account_unavailable",
      "authority_unavailable",
      "gateway_cooldown",
      "gateway_state_unavailable",
      "auth",
      "model_not_found",
      "quota_rate_limit",
      "provider",
      "invalid_response",
      "unverified_failure",
      "transport",
      "timeout",
      "response_too_large",
    ]),
  ),
  httpStatus: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  retryAtMs: Schema.NullOr(Revision),
}).check(
  Schema.makeFilter((probe) => {
    const status = probe.httpStatus;
    if (probe.status === "ok")
      return probe.source === "upstream" &&
        probe.failure === null &&
        probe.retryAtMs === null &&
        status !== null &&
        status >= 200 &&
        status < 300
        ? true
        : "Success requires an actual upstream response.";
    if (probe.status === "unavailable")
      return probe.source === "gateway" &&
        probe.failure !== null &&
        [
          "account_unavailable",
          "authority_unavailable",
          "gateway_cooldown",
          "gateway_state_unavailable",
          "unverified_failure",
          "transport",
          "timeout",
          "response_too_large",
        ].includes(probe.failure)
        ? true
        : "Local failures cannot claim rejected provider credentials.";
    const valid =
      status !== null &&
      (probe.failure === "auth"
        ? [401, 403].includes(status)
        : probe.failure === "model_not_found"
          ? [400, 404].includes(status)
          : probe.failure === "quota_rate_limit"
            ? [402, 429].includes(status)
            : probe.failure === "provider"
              ? status >= 400 && status <= 599
              : probe.failure === "invalid_response"
                ? status >= 200 && status < 300
                : false);
    return probe.source === "upstream" && valid && probe.retryAtMs === null
      ? true
      : "Provider failures require a coherent upstream status.";
  }),
);
export type WorkjetNativeModelProbe = typeof WorkjetNativeModelProbe.Type;
export const WorkjetNativeModelCheckRequest = Schema.Struct({
  ...base,
  action: Schema.Literal("instance.providers.models.check"),
  accountId: Id,
  expectedAccountRevision: Revision,
  modelId: Id,
});
export type WorkjetNativeModelCheckRequest = typeof WorkjetNativeModelCheckRequest.Type;
export const WorkjetNativeModelCheckResponse = Schema.Struct({
  ...base,
  action: Schema.Literal("instance.providers.models.check"),
  accountId: Id,
  accountRevision: Revision,
  probe: WorkjetNativeModelProbe,
});
export type WorkjetNativeModelCheckResponse = typeof WorkjetNativeModelCheckResponse.Type;

const actions = [
  "instance.providers.read",
  "instance.providers.adopt",
  "instance.providers.observe",
  "instance.providers.models.select",
  "instance.providers.models.exclude",
  "instance.providers.account.enable",
  "instance.providers.account.remove",
] as const;
export const WorkjetNativeProviderRequests = [
  Schema.Struct({
    ...base,
    action: Schema.Literals(["instance.providers.read", "instance.providers.adopt"]),
  }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("instance.providers.observe"),
    accountId: Id,
    expectedAccountRevision: Revision,
  }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("instance.providers.models.select"),
    provider: Id,
    models: Models,
    expectedRevision: Counter,
  }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("instance.providers.models.exclude"),
    accountId: Id,
    expectedAccountRevision: Revision,
    models: Models,
    expectedRevision: Counter,
  }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("instance.providers.account.enable"),
    accountId: Id,
    expectedAccountRevision: Revision,
    expectedRevision: Counter,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("instance.providers.account.remove"),
    accountId: Id,
    expectedAccountRevision: Revision,
    expectedRevision: Counter,
  }),
] as const;
export const WorkjetNativeProviderRequest = Schema.Union(WorkjetNativeProviderRequests);
export type WorkjetNativeProviderRequest = typeof WorkjetNativeProviderRequest.Type;
const Attempt = Schema.Struct({
  checkedAtMs: Revision,
  httpStatus: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  elapsedMs: Counter,
  retryAfterSeconds: Schema.NullOr(Counter),
  failure: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/))),
  success: Schema.Boolean,
});
const ReportedQuotaWindow = Schema.Struct({
  kind: Schema.Literals(["five_hour", "seven_day"]),
  status: Schema.Literals(["allowed", "rejected"]),
  resetAtMs: Revision,
  utilization: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
});
const ReportedQuota = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unknown") }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    errorClass: Schema.Literal("quota_read_failed"),
  }),
  Schema.Struct({
    state: Schema.Literal("reported"),
    observedAtMs: Revision,
    windows: Schema.Array(ReportedQuotaWindow).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  }).check(
    Schema.makeFilter((quota) =>
      new Set(quota.windows.map((window) => window.kind)).size === quota.windows.length &&
      quota.windows.every(
        (window) =>
          window.resetAtMs > quota.observedAtMs &&
          window.resetAtMs - quota.observedAtMs <= 608_400_000 &&
          (window.utilization === null || Number.isFinite(window.utilization)),
      )
        ? true
        : "Reported quota windows are inconsistent.",
    ),
  ),
]);
export const WorkjetNativeProviderAccount = Schema.Struct({
  id: Id,
  holder: Schema.Struct({ kind: Schema.Literal("ctox_instance"), id: Id }),
  provider: Id,
  enabled: Schema.Boolean,
  controls: Schema.optionalKey(
    Schema.Struct({ canEnable: Schema.Boolean, canRemove: Schema.Boolean }),
  ),
  reportedQuota: Schema.optionalKey(ReportedQuota),
  credentialReady: Schema.Boolean,

  revision: Revision,
  observedAtMs: Revision,
  nativeAccountReference: WorkjetNativeAccountReference,
  modelCatalogObserved: Schema.Boolean,
  modelCatalog: Schema.Struct({
    observed: Schema.Boolean,
    fresh: Schema.Boolean,
    models: CatalogModels,
    lastSuccessAtMs: Schema.NullOr(Revision),
    lastAttempt: Schema.NullOr(Attempt),
  }),
  excludedModels: Models,
  effectiveModels: CatalogModels,
  inferenceVerified: Schema.Literal(false),
  modelChecks: Schema.optionalKey(
    Schema.Array(WorkjetNativeModelProbe).check(
      Schema.isMaxLength(256),
      Schema.makeFilter((checks) =>
        new Set(checks.map((check) => check.modelId)).size === checks.length
          ? true
          : "Model check IDs must be unique.",
      ),
    ),
  ),
}).check(
  Schema.makeFilter((account) =>
    account.id === account.nativeAccountReference.accountId &&
    account.holder.id === account.nativeAccountReference.holderInstanceId &&
    account.revision === account.nativeAccountReference.accountRevision &&
    account.modelCatalogObserved === account.modelCatalog.observed &&
    (!account.modelCatalog.fresh ||
      (account.modelCatalog.observed &&
        account.modelCatalog.lastSuccessAtMs !== null &&
        account.modelCatalog.lastAttempt?.success === true))
      ? true
      : "Native account reference or catalog metadata is inconsistent.",
  ),
);
export type WorkjetNativeProviderAccount = typeof WorkjetNativeProviderAccount.Type;
export const WorkjetNativeProviderRegistry = Schema.Struct({
  ok: Schema.Literal(true),
  schema: Schema.Literal("ctox.provider-federation-registry.v1"),
  revision: Counter,
  accounts: Schema.Array(WorkjetNativeProviderAccount).check(Schema.isMaxLength(256)),
  providers: Schema.Array(Schema.Struct({ provider: Id, selection: Schema.NullOr(Models) })).check(
    Schema.isMaxLength(256),
  ),
});
export type WorkjetNativeProviderRegistry = typeof WorkjetNativeProviderRegistry.Type;
export const WorkjetNativeProviderResponse = Schema.Struct({
  ...base,
  action: Schema.Literals(actions),
  registry: WorkjetNativeProviderRegistry,
});
export type WorkjetNativeProviderResponse = typeof WorkjetNativeProviderResponse.Type;
