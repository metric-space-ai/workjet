// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - Exercises the byte-level release manifest and checksum contract.

import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";

import pinnedJson from "../../apps/desktop/resources/provider-gateway/host-release.pin.json" with { type: "json" };
import {
  assertVersion,
  buildProviderGatewayHostPin,
  buildProviderGatewayHostReleaseManifest,
  decodeProviderGatewayHostPin,
  decodeProviderGatewayHostReleaseManifest,
  digestBytes,
  findProviderGatewayHostTarget,
  findProviderGatewayHostTargetForHost,
  formatProviderGatewayHostChecksums,
  parseProviderGatewayHostChecksums,
  parseProviderGatewayHostReleaseTag,
  PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
  PROVIDER_GATEWAY_HOST_RELEASE_SCHEMA,
  PROVIDER_GATEWAY_HOST_TARGETS,
  ProviderGatewayHostArtifactError,
  providerGatewayHostAssetName,
  providerGatewayHostAssetUrl,
  providerGatewayHostChecksumsName,
  providerGatewayHostManifestName,
  providerGatewayHostReleaseTag,
  serializeProviderGatewayHostReleaseManifest,
  type ProviderGatewayHostReleaseManifest,
  type StagedProviderGatewayHostArtifact,
} from "./provider-gateway-host-artifacts.ts";

const VERSION = "0.1.0";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function digestFor(seed: string): string {
  return NodeCrypto.createHash("sha256").update(seed).digest("hex");
}

function stagedAll(
  overrides: Partial<Record<string, Partial<StagedProviderGatewayHostArtifact>>> = {},
): StagedProviderGatewayHostArtifact[] {
  return PROVIDER_GATEWAY_HOST_TARGETS.map((target) => ({
    triple: target.triple,
    byteLength: 4_000_000,
    sha256: digestFor(target.triple),
    ...overrides[target.triple],
  }));
}

function manifest(
  staged: StagedProviderGatewayHostArtifact[] = stagedAll(),
): ProviderGatewayHostReleaseManifest {
  return buildProviderGatewayHostReleaseManifest({
    version: VERSION,
    sourceCommit: SOURCE_COMMIT,
    license: "MIT OR AGPL-3.0-only",
    staged,
  });
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (cause) {
    assert.instanceOf(cause, ProviderGatewayHostArtifactError);
    assert.strictEqual((cause as ProviderGatewayHostArtifactError).code, code);
    return;
  }
  assert.fail(`Expected ${code} but the call succeeded.`);
}

it("declares exactly the six targets Workjet and CTOX packaging require", () => {
  assert.deepStrictEqual(
    PROVIDER_GATEWAY_HOST_TARGETS.map((target) => target.triple),
    [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
    ],
  );
  // Every (os, arch) pair resolves to exactly one triple, so a consumer can
  // pick its artifact from process.platform/process.arch without ambiguity.
  const pairs = PROVIDER_GATEWAY_HOST_TARGETS.map((target) => `${target.os}-${target.arch}`);
  assert.strictEqual(new Set(pairs).size, pairs.length);
  assert.strictEqual(
    findProviderGatewayHostTargetForHost("darwin", "arm64")?.triple,
    "aarch64-apple-darwin",
  );
  assert.strictEqual(findProviderGatewayHostTargetForHost("freebsd", "x64"), undefined);
  expectCode(() => findProviderGatewayHostTarget("wasm32-unknown-unknown"), "unknown-target");
});

it("names assets, tags, and URLs from one contract", () => {
  assert.strictEqual(providerGatewayHostReleaseTag(VERSION), "provider-gateway-host-v0.1.0");
  assert.strictEqual(
    parseProviderGatewayHostReleaseTag("provider-gateway-host-v0.2.0-rc.1"),
    "0.2.0-rc.1",
  );
  assert.strictEqual(
    providerGatewayHostAssetName(VERSION, "aarch64-apple-darwin"),
    "workjet-provider-gateway-host-0.1.0-aarch64-apple-darwin",
  );
  assert.strictEqual(
    providerGatewayHostAssetName(VERSION, "x86_64-pc-windows-msvc"),
    "workjet-provider-gateway-host-0.1.0-x86_64-pc-windows-msvc.exe",
  );
  assert.strictEqual(
    providerGatewayHostManifestName(VERSION),
    "workjet-provider-gateway-host-0.1.0.manifest.json",
  );
  assert.strictEqual(
    providerGatewayHostChecksumsName(VERSION),
    "workjet-provider-gateway-host-0.1.0.sha256sums.txt",
  );
  assert.strictEqual(
    providerGatewayHostAssetUrl("provider-gateway-host-v0.1.0", "a.json"),
    "https://github.com/metric-space-ai/workjet/releases/download/provider-gateway-host-v0.1.0/a.json",
  );
  // The gateway tag must not collide with the desktop Release workflow's v*.*.* trigger.
  assert.ok(!providerGatewayHostReleaseTag(VERSION).startsWith("v"));
  expectCode(() => parseProviderGatewayHostReleaseTag("v0.1.0"), "tag-invalid");
  expectCode(
    () => providerGatewayHostAssetUrl("provider-gateway-host-v0.1.0", "../x"),
    "asset-invalid",
  );
  expectCode(() => assertVersion("0.1", "Release version"), "manifest-invalid");
  expectCode(() => assertVersion("01.0.0", "Release version"), "manifest-invalid");
});

it("refuses a release that is missing or duplicating a required target", () => {
  expectCode(
    () =>
      buildProviderGatewayHostReleaseManifest({
        version: VERSION,
        sourceCommit: SOURCE_COMMIT,
        license: "MIT OR AGPL-3.0-only",
        staged: stagedAll().slice(0, 3),
      }),
    "incomplete-release",
  );
  const duplicated = stagedAll();
  const first = duplicated[0];
  assert.ok(first !== undefined);
  expectCode(
    () =>
      buildProviderGatewayHostReleaseManifest({
        version: VERSION,
        sourceCommit: SOURCE_COMMIT,
        license: "MIT OR AGPL-3.0-only",
        staged: [...duplicated, first],
      }),
    "duplicate-target",
  );
  expectCode(
    () =>
      buildProviderGatewayHostReleaseManifest({
        version: VERSION,
        sourceCommit: "not-a-commit",
        license: "MIT OR AGPL-3.0-only",
        staged: stagedAll(),
      }),
    "manifest-invalid",
  );
  expectCode(
    () =>
      buildProviderGatewayHostReleaseManifest({
        version: VERSION,
        sourceCommit: SOURCE_COMMIT,
        license: "MIT OR AGPL-3.0-only",
        staged: stagedAll({ "aarch64-apple-darwin": { byteLength: 1024 ** 4 } }),
      }),
    "budget-exceeded",
  );
});

it("round-trips a complete release manifest through its decoder", () => {
  const built = manifest();
  assert.strictEqual(built.schema, PROVIDER_GATEWAY_HOST_RELEASE_SCHEMA);
  assert.strictEqual(built.releaseTag, "provider-gateway-host-v0.1.0");
  assert.strictEqual(built.artifacts.length, 6);
  const serialized = serializeProviderGatewayHostReleaseManifest(built);
  assert.ok(serialized.endsWith("\n"));
  assert.deepStrictEqual(
    decodeProviderGatewayHostReleaseManifest(JSON.parse(serialized) as unknown),
    built,
  );
});

it("rejects tampered manifest identity, digests, URLs, and schema", () => {
  const base = JSON.parse(serializeProviderGatewayHostReleaseManifest(manifest())) as Record<
    string,
    unknown
  >;
  const mutate = (change: (value: Record<string, unknown>) => void): Record<string, unknown> => {
    const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    change(copy);
    return copy;
  };
  const artifactsOf = (value: Record<string, unknown>): Record<string, unknown>[] =>
    value.artifacts as Record<string, unknown>[];

  expectCode(
    () => decodeProviderGatewayHostReleaseManifest(mutate((v) => (v.schema = "other.v1"))),
    "schema-mismatch",
  );
  expectCode(
    () => decodeProviderGatewayHostReleaseManifest(mutate((v) => (v.component = "other"))),
    "identity-mismatch",
  );
  expectCode(
    () => decodeProviderGatewayHostReleaseManifest(mutate((v) => (v.repository = "evil/repo"))),
    "identity-mismatch",
  );
  expectCode(
    () =>
      decodeProviderGatewayHostReleaseManifest(
        mutate((v) => (v.releaseTag = "provider-gateway-host-v0.9.9")),
      ),
    "identity-mismatch",
  );
  expectCode(
    () =>
      decodeProviderGatewayHostReleaseManifest(
        mutate((v) => {
          const entry = artifactsOf(v)[0];
          if (entry !== undefined) entry.url = "https://evil.example.com/host";
        }),
      ),
    "identity-mismatch",
  );
  expectCode(
    () =>
      decodeProviderGatewayHostReleaseManifest(
        mutate((v) => {
          const entry = artifactsOf(v)[0];
          if (entry !== undefined) entry.fileName = "workjet-provider-gateway-host";
        }),
      ),
    "identity-mismatch",
  );
  expectCode(
    () =>
      decodeProviderGatewayHostReleaseManifest(
        mutate((v) => {
          const entry = artifactsOf(v)[0];
          if (entry !== undefined) entry.sha256 = "NOTAHASH";
        }),
      ),
    "manifest-invalid",
  );
  expectCode(
    () =>
      decodeProviderGatewayHostReleaseManifest(
        mutate((v) => (v.artifacts = artifactsOf(v).slice(0, 5))),
      ),
    "incomplete-release",
  );
  expectCode(
    () => decodeProviderGatewayHostReleaseManifest(mutate((v) => delete v.checksumsFileName)),
    "manifest-invalid",
  );
});

it("emits sha256sum-compatible checksums that round-trip", () => {
  const built = manifest();
  const text = formatProviderGatewayHostChecksums(built);
  const lines = text.trimEnd().split("\n");
  assert.strictEqual(lines.length, 6);
  const first = built.artifacts[0];
  assert.ok(first !== undefined);
  assert.strictEqual(lines[0], `${first.sha256} *${first.fileName}`);
  const parsed = parseProviderGatewayHostChecksums(text);
  assert.strictEqual(parsed.size, 6);
  assert.strictEqual(parsed.get(first.fileName), first.sha256);
  // GNU text mode (two spaces) is accepted on the way back in.
  assert.strictEqual(
    parseProviderGatewayHostChecksums(`${first.sha256}  ${first.fileName}\n`).get(first.fileName),
    first.sha256,
  );
  expectCode(() => parseProviderGatewayHostChecksums("nothex *file"), "checksums-invalid");
  expectCode(() => parseProviderGatewayHostChecksums(`${text}${text}`), "checksums-invalid");
});

it("builds and decodes a pin that records the manifest digest", () => {
  const built = manifest();
  const bytes = Buffer.from(serializeProviderGatewayHostReleaseManifest(built), "utf8");
  const pin = buildProviderGatewayHostPin({ manifest: built, manifestBytes: bytes });
  assert.strictEqual(pin.schema, PROVIDER_GATEWAY_HOST_PIN_SCHEMA);
  assert.strictEqual(pin.status, "pinned");
  assert.strictEqual(pin.release?.manifestSha256, digestBytes(bytes));
  assert.strictEqual(pin.release?.manifestByteLength, bytes.byteLength);
  assert.strictEqual(pin.release?.sourceCommit, SOURCE_COMMIT);
  assert.strictEqual(pin.release?.artifacts.length, 6);
  assert.deepStrictEqual(decodeProviderGatewayHostPin(JSON.parse(JSON.stringify(pin))), pin);
});

it("rejects an unreleased pin that smuggles release material, and a pinned one without it", () => {
  expectCode(
    () =>
      decodeProviderGatewayHostPin({
        schema: PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
        component: "workjet-provider-gateway-host",
        status: "unreleased",
        unreleasedReason: "none yet",
        release: { version: "0.1.0" },
      }),
    "pin-invalid",
  );
  expectCode(
    () =>
      decodeProviderGatewayHostPin({
        schema: PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
        component: "workjet-provider-gateway-host",
        status: "pinned",
      }),
    "pin-invalid",
  );
  expectCode(
    () =>
      decodeProviderGatewayHostPin({
        schema: PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
        component: "workjet-provider-gateway-host",
        status: "maybe",
      }),
    "pin-invalid",
  );
  const built = manifest();
  const bytes = Buffer.from(serializeProviderGatewayHostReleaseManifest(built), "utf8");
  const pin = JSON.parse(
    JSON.stringify(buildProviderGatewayHostPin({ manifest: built, manifestBytes: bytes })),
  ) as { release: Record<string, unknown> };
  pin.release.manifestUrl = "https://evil.example.com/manifest.json";
  expectCode(() => decodeProviderGatewayHostPin(pin), "identity-mismatch");
});

it("keeps the checked-in pin valid against the shared schema", () => {
  const pin = decodeProviderGatewayHostPin(pinnedJson);
  assert.strictEqual(pin.schema, PROVIDER_GATEWAY_HOST_PIN_SCHEMA);
  assert.strictEqual(pin.component, "workjet-provider-gateway-host");
  if (pin.status === "pinned") {
    assert.strictEqual(pin.release?.artifacts.length, PROVIDER_GATEWAY_HOST_TARGETS.length);
  } else {
    assert.strictEqual(pin.status, "unreleased");
    assert.ok((pin.unreleasedReason ?? "").length > 0);
  }
});
