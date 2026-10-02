// @effect-diagnostics nodeBuiltinImport:off - Sealed diagnostic package and failure recovery fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { PROVIDER_GATEWAY_DIAGNOSTIC_FILE } from "@workjet/shared/providerGatewayHostDiagnostic";
import * as Artifact from "./ProviderGatewayHostArtifact.ts";
async function fixture(run: (data: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const data = await createFixture();
  try {
    await run(data);
  } finally {
    await NodeFSP.rm(data.root, { recursive: true, force: true });
  }
}
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
it("resolves an explicit packaged diagnostic host by its own verified receipt", () =>
  fixture(async ({ input, executablePath }) => {
    const resolved = await Effect.runPromise(Artifact.resolveProviderGatewayHostExecutable(input));
    assert.equal(resolved.executablePath, executablePath);
    assert.equal(resolved.source, "diagnostic-package");
    assert.equal(resolved.version, "diagnostic-111111111111");
  }));
it("refuses corruption, architecture mismatch and malformed receipt without falling back", () =>
  fixture(async ({ input, executablePath, manifestPath }) => {
    await assert.rejects(
      Effect.runPromise(
        Artifact.resolveProviderGatewayHostExecutable({
          ...input,
          host: { platform: "darwin", arch: "x64" },
        }),
      ),
      /architecture/u,
    );
    await NodeFSP.writeFile(executablePath, "corrupted");
    await assert.rejects(
      Effect.runPromise(Artifact.resolveProviderGatewayHostExecutable(input)),
      /bytes/u,
    );
    await NodeFSP.writeFile(manifestPath, "invalid json");
    await assert.rejects(
      Effect.runPromise(Artifact.resolveProviderGatewayHostExecutable(input)),
      /receipt is invalid/u,
    );
  }));
it("ignores diagnostic receipts in development and preserves explicit override priority", () =>
  fixture(async ({ input }) => {
    const resolved = await Effect.runPromise(
      Artifact.resolveProviderGatewayHostExecutable({
        ...input,
        environment: { ...input.environment, isPackaged: false },
        loadDiagnosticPackage: () => {
          throw new Error("must not read");
        },
        resolveWorkspaceBuild: () => undefined,
      }),
    );
    assert.equal(resolved.source, "local-build");
    const override = await Effect.runPromise(
      Artifact.resolveProviderGatewayHostExecutable({
        ...input,
        executableOverride: "/explicit/host",
        loadDiagnosticPackage: () => {
          throw new Error("must not read");
        },
      }),
    );
    assert.equal(override.source, "override");
  }));
it("rejects a symlink or oversized diagnostic receipt", () =>
  fixture(async ({ input, manifestPath, root }) => {
    await NodeFSP.writeFile(manifestPath, " ".repeat(20 * 1024));
    await assert.rejects(
      Effect.runPromise(Artifact.resolveProviderGatewayHostExecutable(input)),
      /receipt is invalid/u,
    );
    await NodeFSP.rm(manifestPath);
    await NodeFSP.symlink(NodePath.join(root, "missing"), manifestPath);
    await assert.rejects(
      Effect.runPromise(Artifact.resolveProviderGatewayHostExecutable(input)),
      /receipt is invalid/u,
    );
  }));
