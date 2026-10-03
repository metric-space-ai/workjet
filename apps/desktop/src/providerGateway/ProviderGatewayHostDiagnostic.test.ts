// @effect-diagnostics nodeBuiltinImport:off - Sealed diagnostic package and failure recovery fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { PROVIDER_GATEWAY_DIAGNOSTIC_FILE } from "@workjet/shared/providerGatewayHostDiagnostic";
import * as Artifact from "./ProviderGatewayHostArtifact.ts";

const fixture = Effect.acquireRelease(Effect.promise(createFixture), (data) =>
  Effect.promise(() => NodeFSP.rm(data.root, { recursive: true, force: true })),
);

async function createFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "host-diagnostic-resolve-"));
  const resource = NodePath.join(root, Artifact.PROVIDER_GATEWAY_HOST_RESOURCE_DIRECTORY);
  await NodeFSP.mkdir(resource);
  const binary = Buffer.from("isolated diagnostic executable fixture");
  const executablePath = NodePath.join(resource, "workjet-provider-gateway-host");
  await NodeFSP.writeFile(executablePath, binary, { mode: 0o755 });
  const manifestPath = NodePath.join(resource, PROVIDER_GATEWAY_DIAGNOSTIC_FILE);
  const manifest = {
    schema: "workjet.provider-gateway-host.diagnostic-package.v1",
    component: "workjet-provider-gateway-host",
    sourceCommit: "1".repeat(40),
    nativeSource: { hostTree: "2".repeat(40), proxyTree: "3".repeat(40) },
    version: "0.1.1",
    artifact: {
      triple: "aarch64-apple-darwin",
      os: "darwin",
      arch: "arm64",
      fileName: "workjet-provider-gateway-host",
      byteLength: binary.byteLength,
      sha256: NodeCrypto.createHash("sha256").update(binary).digest("hex"),
    },
  };
  await NodeFSP.writeFile(manifestPath, JSON.stringify(manifest));
  const input = {
    environment: { isPackaged: true, rootDir: root, resourcesPath: root },
    host: { platform: "darwin", arch: "arm64" },
    pin: Artifact.decodeProviderGatewayHostPin({
      schema: Artifact.PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
      component: Artifact.PROVIDER_GATEWAY_HOST_COMPONENT,
      status: "unreleased",
      unreleasedReason: "fixture release pending",
    }),
  };
  return { root, executablePath, manifestPath, manifest, input };
}

it.effect("resolves an explicit packaged diagnostic host by its own verified receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { input, executablePath } = yield* fixture;
      const resolved = yield* Artifact.resolveProviderGatewayHostExecutable(input);
      NodeAssert.equal(resolved.executablePath, executablePath);
      NodeAssert.equal(resolved.source, "diagnostic-package");
      NodeAssert.equal(resolved.version, "diagnostic-111111111111");
    }),
  ),
);

it.effect(
  "refuses corruption, architecture mismatch and malformed receipt without falling back",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { input, executablePath, manifestPath } = yield* fixture;
        const architectureFailure = yield* Artifact.resolveProviderGatewayHostExecutable({
          ...input,
          host: { platform: "darwin", arch: "x64" },
        }).pipe(Effect.flip);
        NodeAssert.match(architectureFailure.message, /architecture/u);
        yield* Effect.promise(() => NodeFSP.writeFile(executablePath, "corrupted"));
        const corruptionFailure = yield* Artifact.resolveProviderGatewayHostExecutable(input).pipe(
          Effect.flip,
        );
        NodeAssert.match(corruptionFailure.message, /bytes/u);
        yield* Effect.promise(() => NodeFSP.writeFile(manifestPath, "invalid json"));
        const malformedFailure = yield* Artifact.resolveProviderGatewayHostExecutable(input).pipe(
          Effect.flip,
        );
        NodeAssert.match(malformedFailure.message, /receipt is invalid/u);
      }),
    ),
);

it.effect(
  "ignores diagnostic receipts in development and preserves explicit override priority",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { input } = yield* fixture;
        const resolved = yield* Artifact.resolveProviderGatewayHostExecutable({
          ...input,
          environment: { ...input.environment, isPackaged: false },
          loadDiagnosticPackage: () => {
            throw new Error("must not read");
          },
          resolveWorkspaceBuild: () => undefined,
        });
        NodeAssert.equal(resolved.source, "local-build");
        const override = yield* Artifact.resolveProviderGatewayHostExecutable({
          ...input,
          executableOverride: "/explicit/host",
          loadDiagnosticPackage: () => {
            throw new Error("must not read");
          },
        });
        NodeAssert.equal(override.source, "override");
      }),
    ),
);

it.effect("rejects a symlink or oversized diagnostic receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { input, manifestPath, root } = yield* fixture;
      yield* Effect.promise(() => NodeFSP.writeFile(manifestPath, " ".repeat(20 * 1024)));
      const oversizedFailure = yield* Artifact.resolveProviderGatewayHostExecutable(input).pipe(
        Effect.flip,
      );
      NodeAssert.match(oversizedFailure.message, /receipt is invalid/u);
      yield* Effect.promise(async () => {
        await NodeFSP.rm(manifestPath);
        await NodeFSP.symlink(NodePath.join(root, "missing"), manifestPath);
      });
      const symlinkFailure = yield* Artifact.resolveProviderGatewayHostExecutable(input).pipe(
        Effect.flip,
      );
      NodeAssert.match(symlinkFailure.message, /receipt is invalid/u);
    }),
  ),
);
