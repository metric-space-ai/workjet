import * as Schema from "effect/Schema";
const DesktopSshEnvironmentTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65535))),
});

const Text = Schema.String.check(Schema.isMaxLength(4096), Schema.isNonEmpty());
const Bytes = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export const ComputerRoles = Schema.Struct({ build: Schema.Boolean, storage: Schema.Boolean });
export type ComputerRoles = typeof ComputerRoles.Type;
export const ComputerConnection = Schema.Union([
  Schema.TaggedStruct("local", {}),
  Schema.TaggedStruct("ssh", { target: DesktopSshEnvironmentTargetSchema }),
  Schema.TaggedStruct("tailscale", { target: DesktopSshEnvironmentTargetSchema }),
]);
export type ComputerConnection = typeof ComputerConnection.Type;
export const ComputerFacts = Schema.Struct({
  checkedAt: Text,
  machineId: Schema.NullOr(Text),
  operatingSystem: Text,
  architecture: Text,
  cpuCores: Schema.Int.check(Schema.isGreaterThan(0)),
  ramBytes: Bytes,
  homeDirectory: Text,
  workDirectory: Text,
  freeBytes: Bytes,
  gpus: Schema.Array(
    Schema.Struct({
      model: Text,
      vramBytes: Schema.NullOr(Bytes),
      unifiedMemory: Schema.Boolean,
    }),
  ),
  toolchains: Schema.Record(Schema.String, Text),
  codingTools: Schema.Record(Schema.String, Text),
  warnings: Schema.Array(Text),
});
export type ComputerFacts = typeof ComputerFacts.Type;
export const ComputerMetadata = Schema.Struct({
  connection: Schema.NullOr(ComputerConnection),
  facts: Schema.NullOr(ComputerFacts),
  roles: ComputerRoles,
  active: Schema.Boolean,
  hostKeyFingerprint: Schema.NullOr(Text),
  identityFiles: Schema.Array(Text),
  status: Schema.Literals(["ready", "unreachable", "unverified"]),
  error: Schema.NullOr(Text),
  previousIds: Schema.Array(Text),
  /** Retained public legacy rows/configurations; never credentials. */
  legacyRecords: Schema.Array(Schema.Unknown),
});
export type ComputerMetadata = typeof ComputerMetadata.Type;
export const ComputerControlInput = Schema.Union([
  Schema.TaggedStruct("list", {}),
  Schema.TaggedStruct("add", {
    id: Text,
    label: Text,
    environmentId: Text,
    connection: ComputerConnection,
  }),
  Schema.TaggedStruct("recheck", { id: Text }),
  Schema.TaggedStruct("setActive", { id: Text, active: Schema.Boolean }),
  Schema.TaggedStruct("setRoles", { id: Text, roles: ComputerRoles }),
  Schema.TaggedStruct("remove", {
    id: Text,
    mode: Schema.Literals(["workjet-only", "workjet-and-files"]),
  }),
]);
export type ComputerControlInput = typeof ComputerControlInput.Type;
export const ComputerDerivedCapacity = Schema.Struct({
  concurrentBuilds: Schema.Literal(1),
  workersPerBuild: Schema.Int.check(Schema.isGreaterThan(0)),
  useGpu: Schema.Boolean,
  directory: Text,
  enoughFreeSpace: Schema.Boolean,
});
export const ComputerControlResult = Schema.Struct({
  computers: Schema.Array(
    Schema.Struct({
      id: Text,
      label: Text,
      environmentId: Text,
      metadata: ComputerMetadata,
      capacity: Schema.NullOr(ComputerDerivedCapacity),
    }),
  ),
  removedPaths: Schema.Array(
    Schema.Struct({
      path: Text,
      status: Schema.Literals(["removed", "absent", "refused", "failed"]),
    }),
  ),
});
export type ComputerControlResult = typeof ComputerControlResult.Type;
export const ComputerSshKeyInfo = Schema.Struct({
  path: Text,
  publicKeyFingerprint: Schema.NullOr(Text),
});
export type ComputerSshKeyInfo = typeof ComputerSshKeyInfo.Type;
