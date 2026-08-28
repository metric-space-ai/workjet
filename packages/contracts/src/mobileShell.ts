// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Ed25519Signature = Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/u));
const SafeRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/u),
  Schema.makeFilter((path) =>
    path === "vendor/ctox-office" || path.startsWith("vendor/ctox-office/")
      ? "Office files must ship in their own signed on-demand pack."
      : true,
  ),
);
const NonNegativeSize = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const CtoxMobileShellPackFileV1 = Schema.Struct({
  path: SafeRelativePath,
  size: NonNegativeSize,
  sha256: Sha256,
});
export type CtoxMobileShellPackFileV1 = typeof CtoxMobileShellPackFileV1.Type;

/**
 * Field order is the canonical Ed25519 signing order. Producers sign the
 * UTF-8 JSON encoding of these fields, in this exact order, without the
 * `signature` property. File order is also signature-bearing.
 */
export const CtoxMobileShellPackManifestV1 = Schema.Struct({
  type: Schema.Literal("ctox.mobile.shell-pack.v1"),
  packId: Identifier,
  businessOsRevision: Identifier,
  appVersion: Identifier,
  totalSize: NonNegativeSize,
  files: Schema.Array(CtoxMobileShellPackFileV1).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20_000),
  ),
  signingKeyId: Identifier,
  signature: Ed25519Signature,
});
export type CtoxMobileShellPackManifestV1 = typeof CtoxMobileShellPackManifestV1.Type;

export const CtoxMobileShellPackArtifactV1 = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048), Schema.isPattern(/^https:\/\//u)),
  size: NonNegativeSize,
  sha256: Sha256,
  contentType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  expiresAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  etag: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type CtoxMobileShellPackArtifactV1 = typeof CtoxMobileShellPackArtifactV1.Type;

export const CtoxMobileShellPackDistributionV1 = Schema.Struct({
  type: Schema.Literal("ctox.mobile.shell-pack-distribution.v1"),
  manifest: CtoxMobileShellPackManifestV1,
  artifact: CtoxMobileShellPackArtifactV1,
});
export type CtoxMobileShellPackDistributionV1 = typeof CtoxMobileShellPackDistributionV1.Type;

export const CtoxMobileShellPackResolveInput = Schema.Struct({
  businessOsRevision: Identifier,
  appVersion: Identifier,
});
export type CtoxMobileShellPackResolveInput = typeof CtoxMobileShellPackResolveInput.Type;

export const CtoxMobileShellPackResolveResult = CtoxMobileShellPackDistributionV1;
export type CtoxMobileShellPackResolveResult = typeof CtoxMobileShellPackResolveResult.Type;

export const CtoxMobileShellPackTrustKey = Schema.Struct({
  signingKeyId: Identifier,
  algorithm: Schema.Literal("Ed25519"),
  publicKey: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  state: Schema.Literals(["current", "next"]),
});
export type CtoxMobileShellPackTrustKey = typeof CtoxMobileShellPackTrustKey.Type;
