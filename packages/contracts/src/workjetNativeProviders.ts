import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetNativeAccountReference } from "./workjet.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }));
const Revision = Counter.check(Schema.isGreaterThanOrEqualTo(1));
const Uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i));
const Models = Schema.Array(Id).check(Schema.isMaxLength(256));
const CatalogModels = Schema.Array(Id).check(Schema.isMaxLength(1024));
const base = { version: Schema.Literal(1), operationId: Uuid };
const actions = ["instance.providers.read", "instance.providers.adopt", "instance.providers.observe",
  "instance.providers.models.select", "instance.providers.models.exclude"] as const;
export const WorkjetNativeProviderRequests = [
  Schema.Struct({ ...base, action: Schema.Literals(["instance.providers.read", "instance.providers.adopt"]) }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.providers.observe"), accountId: Id, expectedAccountRevision: Revision }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.providers.models.select"), provider: Id, models: Models, expectedRevision: Counter }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.providers.models.exclude"), accountId: Id, expectedAccountRevision: Revision,
    models: Models, expectedRevision: Counter }),
] as const;
export const WorkjetNativeProviderRequest = Schema.Union(WorkjetNativeProviderRequests);
export type WorkjetNativeProviderRequest = typeof WorkjetNativeProviderRequest.Type;
const Attempt = Schema.Struct({
  checkedAtMs: Revision, httpStatus: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  elapsedMs: Counter, retryAfterSeconds: Schema.NullOr(Counter),
  failure: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/))), success: Schema.Boolean,
});
export const WorkjetNativeProviderAccount = Schema.Struct({
  id: Id, holder: Schema.Struct({ kind: Schema.Literal("ctox_instance"), id: Id }),
  provider: Id, enabled: Schema.Boolean, credentialReady: Schema.Boolean,
  revision: Revision, observedAtMs: Revision, nativeAccountReference: WorkjetNativeAccountReference,
  modelCatalogObserved: Schema.Boolean,
  modelCatalog: Schema.Struct({ observed: Schema.Boolean, fresh: Schema.Boolean, models: CatalogModels,
    lastSuccessAtMs: Schema.NullOr(Revision), lastAttempt: Schema.NullOr(Attempt) }),
  excludedModels: Models, effectiveModels: CatalogModels, inferenceVerified: Schema.Literal(false),
}).check(Schema.makeFilter(account =>
  account.id === account.nativeAccountReference.accountId &&
  account.holder.id === account.nativeAccountReference.holderInstanceId &&
  account.revision === account.nativeAccountReference.accountRevision &&
  account.modelCatalogObserved === account.modelCatalog.observed &&
  (!account.modelCatalog.fresh || (account.modelCatalog.observed &&
    account.modelCatalog.lastSuccessAtMs !== null && account.modelCatalog.lastAttempt?.success === true))
    ? true : "Native account reference or catalog metadata is inconsistent.",
));
export type WorkjetNativeProviderAccount = typeof WorkjetNativeProviderAccount.Type;
export const WorkjetNativeProviderRegistry = Schema.Struct({
  ok: Schema.Literal(true), schema: Schema.Literal("ctox.provider-federation-registry.v1"), revision: Counter,
  accounts: Schema.Array(WorkjetNativeProviderAccount).check(Schema.isMaxLength(256)),
  providers: Schema.Array(Schema.Struct({ provider: Id, selection: Schema.NullOr(Models) })).check(Schema.isMaxLength(256)),
});
export type WorkjetNativeProviderRegistry = typeof WorkjetNativeProviderRegistry.Type;
export const WorkjetNativeProviderResponse = Schema.Struct({
  ...base, action: Schema.Literals(actions), registry: WorkjetNativeProviderRegistry,
});
export type WorkjetNativeProviderResponse = typeof WorkjetNativeProviderResponse.Type;
