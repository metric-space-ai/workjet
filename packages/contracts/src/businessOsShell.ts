// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const SemVer = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Ed25519Signature = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/));
const HttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^https:\/\/[^\s]+$/),
);
const Rfc3339Timestamp = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
);
const ShellChannel = Schema.Literals(["stable", "beta", "nightly"]);
const NullableSemVer = Schema.NullOr(SemVer);

export const BusinessOsShellCompatibility = Schema.Struct({
  workjetMinVersion: SemVer,
  workjetMaxVersion: NullableSemVer,
  ctoxMinVersion: SemVer,
  ctoxMaxVersion: NullableSemVer,
  shellProtocol: Schema.Literal("workjet.business-os-shell.v1"),
});
export type BusinessOsShellCompatibility = typeof BusinessOsShellCompatibility.Type;

const BusinessOsShellArtifact = Schema.Struct({
  url: HttpsUrl,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Sha256,
  contentType: Schema.Literal("application/gzip"),
});

const BusinessOsShellReleaseFile = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Sha256,
});

export const BusinessOsShellReleaseManifestV2 = Schema.Struct({
  type: Schema.Literal("ctox.business-os-shell.release.v2"),
  version: SemVer,
  channel: ShellChannel,
  sourceCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  publishedAt: Rfc3339Timestamp,
  artifact: BusinessOsShellArtifact,
  compatibility: BusinessOsShellCompatibility,
  files: Schema.Array(BusinessOsShellReleaseFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5_000),
  ),
  provenance: Schema.Struct({
    embeddedManifestSha256: Sha256,
    sbomUrl: HttpsUrl,
  }),
  signingKeyId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  signature: Ed25519Signature,
});
export type BusinessOsShellReleaseManifestV2 = typeof BusinessOsShellReleaseManifestV2.Type;

export const BusinessOsShellChannelPointerV1 = Schema.Struct({
  type: Schema.Literal("ctox.business-os-shell.channel.v1"),
  channel: ShellChannel,
  version: SemVer,
  manifestUrl: HttpsUrl,
  manifestSha256: Sha256,
  publishedAt: Rfc3339Timestamp,
  signingKeyId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  signature: Ed25519Signature,
});
export type BusinessOsShellChannelPointerV1 = typeof BusinessOsShellChannelPointerV1.Type;

export const BusinessOsShellUpdatePhase = Schema.Literals([
  "current",
  "checking",
  "available",
  "download",
  "verify",
  "ready",
  "restart",
  "failed",
  "incompatible",
  "blocked",
  "rollback",
  "recovery",
]);
export type BusinessOsShellUpdatePhase = typeof BusinessOsShellUpdatePhase.Type;

export const BusinessOsShellUpdateStatus = Schema.Struct({
  activeVersion: Schema.NullOr(SemVer),
  desiredVersion: Schema.NullOr(SemVer),
  latestCompatibleVersion: Schema.NullOr(SemVer),
  channel: ShellChannel,
  phase: BusinessOsShellUpdatePhase,
  health: Schema.Literals(["healthy", "degraded", "unknown"]),
  administrable: Schema.Boolean,
  recoveryShell: Schema.Boolean,
  lastCheckedAt: Schema.NullOr(Rfc3339Timestamp),
  lastActivatedAt: Schema.NullOr(Rfc3339Timestamp),
  errorCode: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  pause: Schema.NullOr(
    Schema.Struct({
      reason: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      expiresAt: Rfc3339Timestamp,
    }),
  ),
});
export type BusinessOsShellUpdateStatus = typeof BusinessOsShellUpdateStatus.Type;
