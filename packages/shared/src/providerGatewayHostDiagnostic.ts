// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

/** A sealed, source-identified local Mac package; never a published release pin. */
export const PROVIDER_GATEWAY_DIAGNOSTIC_FILE = "diagnostic-package.manifest.json";
export const PROVIDER_GATEWAY_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
export const PROVIDER_GATEWAY_DIAGNOSTIC_EXECUTABLE_MAX_BYTES = 128 * 1024 * 1024;
const Commit = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/u)));
export const ProviderGatewayHostDiagnostic = Schema.Struct({
  schema: Schema.Literal("workjet.provider-gateway-host.diagnostic-package.v1"),
  component: Schema.Literal("workjet-provider-gateway-host"),
  sourceCommit: Commit,
  nativeSource: Schema.Struct({ hostTree: Commit, proxyTree: Commit }),
  version: Schema.String,
  artifact: Schema.Struct({
    triple: Schema.Literals(["aarch64-apple-darwin", "x86_64-apple-darwin"]),
    os: Schema.Literal("darwin"),
    arch: Schema.Literals(["arm64", "x64"]),
    fileName: Schema.Literal("workjet-provider-gateway-host"),
    byteLength: Schema.Int.pipe(
      Schema.check(
        Schema.isBetween({ minimum: 1, maximum: PROVIDER_GATEWAY_DIAGNOSTIC_EXECUTABLE_MAX_BYTES }),
      ),
    ),
    sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  }),
});
export type ProviderGatewayHostDiagnostic = typeof ProviderGatewayHostDiagnostic.Type;
const decode = Schema.decodeUnknownSync(ProviderGatewayHostDiagnostic, {
  onExcessProperty: "error",
});
export function decodeProviderGatewayHostDiagnostic(input: unknown): ProviderGatewayHostDiagnostic {
  const manifest = decode(input);
  const expected =
    manifest.artifact.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (manifest.artifact.triple !== expected)
    throw new Error("Diagnostic host architecture and triple disagree.");
  return manifest;
}
