import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetCapabilityId } from "./workjet.ts";

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const CapabilityVersion = TrimmedNonEmptyString.check(
  Schema.isPattern(SEMANTIC_VERSION_PATTERN),
);
export type CapabilityVersion = typeof CapabilityVersion.Type;

export const CapabilityAdapter = Schema.Literals([
  "t3-mcp",
  "t3-prompt",
  "ctox-business-os-mcp",
  "ctox-business-command",
]);
export type CapabilityAdapter = typeof CapabilityAdapter.Type;

export const CapabilityPermissionRequirement = Schema.Literals([
  "process.spawn",
  "network.search",
  "network.read",
  "browser.automation",
  "filesystem.read",
]);
export type CapabilityPermissionRequirement = typeof CapabilityPermissionRequirement.Type;

export const CapabilityDisplayMetadata = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type CapabilityDisplayMetadata = typeof CapabilityDisplayMetadata.Type;

export const CapabilityPromptContribution = Schema.NullOr(
  Schema.Struct({
    instructions: TrimmedNonEmptyString,
  }),
);
export type CapabilityPromptContribution = typeof CapabilityPromptContribution.Type;

export const CapabilitySecretRequirement = Schema.Struct({
  reference: TrimmedNonEmptyString,
  optional: Schema.Boolean,
});
export type CapabilitySecretRequirement = typeof CapabilitySecretRequirement.Type;

export type CapabilityJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CapabilityJsonValue>
  | { readonly [key: string]: CapabilityJsonValue };

export const CapabilityJsonValue: Schema.Codec<CapabilityJsonValue> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number,
  Schema.String,
  Schema.Array(Schema.suspend((): Schema.Codec<CapabilityJsonValue> => CapabilityJsonValue)),
  Schema.Record(
    TrimmedNonEmptyString,
    Schema.suspend((): Schema.Codec<CapabilityJsonValue> => CapabilityJsonValue),
  ),
]);

export const CapabilityJsonSchemaDocument = Schema.Record(
  TrimmedNonEmptyString,
  CapabilityJsonValue,
).check(Schema.isMinProperties(1));
export type CapabilityJsonSchemaDocument = typeof CapabilityJsonSchemaDocument.Type;

export const CapabilityManifestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: WorkjetCapabilityId,
  version: CapabilityVersion,
  metadata: CapabilityDisplayMetadata,
  promptContribution: CapabilityPromptContribution,
  permissionRequirements: Schema.Array(CapabilityPermissionRequirement),
  secretRequirements: Schema.Array(CapabilitySecretRequirement),
  inputSchema: CapabilityJsonSchemaDocument,
  outputSchema: CapabilityJsonSchemaDocument,
  supportedAdapters: Schema.Array(CapabilityAdapter),
});
export type CapabilityManifestV1 = typeof CapabilityManifestV1.Type;

export const CapabilityAvailabilityStatus = Schema.Literals([
  "available",
  "unavailable",
  "incompatible",
]);
export type CapabilityAvailabilityStatus = typeof CapabilityAvailabilityStatus.Type;

export const CapabilityAvailability = Schema.Struct({
  capabilityId: WorkjetCapabilityId,
  status: CapabilityAvailabilityStatus,
  requestedVersion: CapabilityVersion,
  installedVersion: Schema.NullOr(CapabilityVersion),
  reason: Schema.NullOr(TrimmedNonEmptyString),
});
export type CapabilityAvailability = typeof CapabilityAvailability.Type;

export const CapabilityThreadActivationTarget = Schema.Struct({
  kind: Schema.Literal("thread"),
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type CapabilityThreadActivationTarget = typeof CapabilityThreadActivationTarget.Type;

export const CapabilityCtoxInstanceActivationTarget = Schema.Struct({
  kind: Schema.Literal("ctox-instance"),
  instanceId: TrimmedNonEmptyString,
});
export type CapabilityCtoxInstanceActivationTarget =
  typeof CapabilityCtoxInstanceActivationTarget.Type;

export const CapabilityActivationTarget = Schema.Union([
  CapabilityThreadActivationTarget,
  CapabilityCtoxInstanceActivationTarget,
]);
export type CapabilityActivationTarget = typeof CapabilityActivationTarget.Type;

export const CapabilityActivation = Schema.Struct({
  capabilityId: WorkjetCapabilityId,
  target: CapabilityActivationTarget,
  enabled: Schema.Boolean,
  actorId: TrimmedNonEmptyString,
  changedAt: IsoDateTime,
});
export type CapabilityActivation = typeof CapabilityActivation.Type;

export class CapabilityUnknownIdError extends Schema.TaggedErrorClass<CapabilityUnknownIdError>()(
  "CapabilityUnknownIdError",
  {
    capabilityId: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Unknown capability ID: ${this.capabilityId}`;
  }
}

export class CapabilityIncompatibleVersionError extends Schema.TaggedErrorClass<CapabilityIncompatibleVersionError>()(
  "CapabilityIncompatibleVersionError",
  {
    capabilityId: WorkjetCapabilityId,
    requestedVersion: CapabilityVersion,
    installedVersion: Schema.NullOr(CapabilityVersion),
  },
) {
  override get message(): string {
    const installedVersion = this.installedVersion ?? "not installed";
    return `Capability ${this.capabilityId} version ${installedVersion} does not satisfy requested version ${this.requestedVersion}`;
  }
}

export const CapabilityContractError = Schema.Union([
  CapabilityUnknownIdError,
  CapabilityIncompatibleVersionError,
]);
export type CapabilityContractError = typeof CapabilityContractError.Type;
