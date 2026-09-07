// @effect-diagnostics nodeBuiltinImport:off - Isolated release staging and corruption fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import {
  buildProviderGatewayHostPin,
  buildProviderGatewayHostReleaseManifest,
  digestBytes,
  PROVIDER_GATEWAY_HOST_TARGETS,
  serializeProviderGatewayHostReleaseManifest,
} from "./provider-gateway-host-artifacts.ts";
import { prepareProviderGatewayHost } from "./prepare-provider-gateway-host.ts";

async function withFixture(run: (data: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const data = await fixture();
  try {
    await run(data);
  } finally {
    await NodeFSP.rm(data.root, { recursive: true, force: true });
  }
}

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-host-stage-"));
  const binaries = PROVIDER_GATEWAY_HOST_TARGETS.map((target) => ({
    target,
    bytes: new TextEncoder().encode(`isolated host fixture for ${target.triple}`),
  }));
  const manifest = buildProviderGatewayHostReleaseManifest({
    version: "0.1.0",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    license: "MIT OR AGPL-3.0-only",
    staged: binaries.map(({ target, bytes }) => ({
      triple: target.triple,
      byteLength: bytes.byteLength,
      sha256: digestBytes(bytes),
    })),
  });
  const manifestBytes = new TextEncoder().encode(
    serializeProviderGatewayHostReleaseManifest(manifest),
  );
  const pin = buildProviderGatewayHostPin({ manifest, manifestBytes });
  const responses = new Map<string, Uint8Array<ArrayBuffer>>();
  responses.set(pin.release!.manifestUrl, manifestBytes);
  for (const artifact of manifest.artifacts) {
    responses.set(
      artifact.url,
      binaries.find((item) => item.target.triple === artifact.triple)!.bytes,
    );
  }
  const requests: string[] = [];
  const options = {
    repoRoot: root,
    platform: "mac" as const,
    arch: "arm64" as const,
    pin,
    fetchArtifact: async (url: string) => {
      requests.push(url);
      const bytes = responses.get(url);
      if (!bytes) throw new Error(`Unexpected fixture download: ${url}`);
      return new Response(bytes);
    },
  };
  return { root, manifest, pin, responses, requests, options };
}

it("stages the requested host, restores executable mode and reuses verified cached bytes offline", () =>
  withFixture(async ({ options, manifest, requests }) => {
    const prepared = await prepareProviderGatewayHost(options);
    const artifact = manifest.artifacts.find(
      (item) => item.os === "darwin" && item.arch === "arm64",
    )!;
    const executable = NodePath.join(prepared.installPath, artifact.fileName);
    NodeAssert.equal(digestBytes(await NodeFSP.readFile(executable)), artifact.sha256);
    NodeAssert.equal(requests.length, 2);
    await NodeFSP.chmod(executable, 0o644);
    await prepareProviderGatewayHost({
      ...options,
      fetchArtifact: async () => {
        throw new Error("offline");
      },
    });
    await NodeFSP.access(executable, NodeFSP.constants.X_OK);
  }));

it("re-downloads a corrupted cached binary instead of packaging it", () =>
  withFixture(async ({ options, manifest, requests }) => {
    const prepared = await prepareProviderGatewayHost(options);
    const artifact = manifest.artifacts.find(
      (item) => item.os === "darwin" && item.arch === "arm64",
    )!;
    const executable = NodePath.join(prepared.installPath, artifact.fileName);
    await NodeFSP.writeFile(executable, new Uint8Array(artifact.byteLength));
    await prepareProviderGatewayHost(options);
    NodeAssert.equal(requests.length, 3);
    NodeAssert.equal(digestBytes(await NodeFSP.readFile(executable)), artifact.sha256);
  }));

it("refuses corrupted and oversized downloads before placing an executable in the stage", () =>
  withFixture(async ({ options, manifest, responses }) => {
    const artifact = manifest.artifacts.find(
      (item) => item.os === "darwin" && item.arch === "arm64",
    )!;
    responses.set(artifact.url, new Uint8Array(artifact.byteLength));
    await NodeAssert.rejects(prepareProviderGatewayHost(options), /pinned size and SHA-256/);
    responses.set(artifact.url, new Uint8Array(artifact.byteLength + 1));
    await NodeAssert.rejects(prepareProviderGatewayHost(options), /pinned byte length/);
    const executable = NodePath.join(
      options.repoRoot,
      ".deps/workjet-provider-gateway-host/0.1.0/darwin-arm64",
      artifact.fileName,
    );
    await NodeAssert.rejects(NodeFSP.stat(executable), { code: "ENOENT" });
  }));

it("checks manifest bytes and their agreement with the committed per-platform pin", () =>
  withFixture(async ({ options, pin, responses }) => {
    const original = responses.get(pin.release!.manifestUrl)!;
    responses.set(pin.release!.manifestUrl, new Uint8Array(original.byteLength));
    await NodeAssert.rejects(prepareProviderGatewayHost(options), /pinned size and SHA-256/);
    responses.set(pin.release!.manifestUrl, original);
    const mismatched = structuredClone(pin);
    const release = mismatched.release!;
    const altered = {
      ...release,
      artifacts: release.artifacts.map((item) => ({ ...item, sha256: "a".repeat(64) })),
    };
    await NodeAssert.rejects(
      prepareProviderGatewayHost({ ...options, pin: { ...pin, release: altered } }),
      /manifest disagrees/,
    );
  }));

it("stages both Apple architectures for a universal app", () =>
  withFixture(async ({ options, requests }) => {
    const prepared = await prepareProviderGatewayHost({ ...options, arch: "universal" });
    const files = await NodeFSP.readdir(prepared.installPath);
    NodeAssert.ok(files.some((file) => file.endsWith("aarch64-apple-darwin")));
    NodeAssert.ok(files.some((file) => file.endsWith("x86_64-apple-darwin")));
    NodeAssert.equal(requests.length, 3);
  }));

it("rejects an unreleased host before downloading anything", () =>
  withFixture(async ({ options, requests }) => {
    await NodeAssert.rejects(
      prepareProviderGatewayHost({
        ...options,
        pin: {
          schema: "workjet.provider-gateway-host.pin.v1",
          component: "workjet-provider-gateway-host",
          status: "unreleased",
          unreleasedReason: "fixture has no published host",
        },
      }),
      /Cannot package Workjet/,
    );
    NodeAssert.equal(requests.length, 0);
  }));
