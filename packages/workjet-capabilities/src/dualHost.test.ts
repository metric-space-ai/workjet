import { describe, expect, it } from "vite-plus/test";

import { builtInCapabilityManifests } from "./manifests.ts";
import {
  canonicalCapabilityJson,
  CAPABILITY_HOST_ADAPTERS,
  CAPABILITY_LOCK_DIMENSIONS,
  capabilityConformanceCoverage,
  capabilityHostForAdapter,
  capabilityLockPolicies,
  capabilityManifestLockProjection,
  capabilitySchemaLockProjection,
  compareCapabilityProjections,
  dualHostCapabilities,
  dualHostCapabilityIds,
  findHostPolicyDifference,
  greppyArtifactSha256,
  greppyImplementationRevision,
  HOST_POLICY_DIFFERENCES,
} from "./dualHost.ts";

describe("dual-host capability derivation", () => {
  it("splits every adapter in the manifest vocabulary onto exactly one host", () => {
    const adapters = new Set(
      builtInCapabilityManifests.flatMap((manifest) => [...manifest.supportedAdapters]),
    );
    for (const adapter of adapters) {
      const host = capabilityHostForAdapter(adapter);
      expect(CAPABILITY_HOST_ADAPTERS[host]).toContain(adapter);
    }
    expect([...CAPABILITY_HOST_ADAPTERS.code, ...CAPABILITY_HOST_ADAPTERS.ctox].length).toBe(
      new Set([...CAPABILITY_HOST_ADAPTERS.code, ...CAPABILITY_HOST_ADAPTERS.ctox]).size,
    );
  });

  it("derives dual-host membership from the catalog rather than a second list", () => {
    expect(dualHostCapabilityIds).toEqual(["greppy", "web-search", "web-stack-browser"]);
    for (const { manifest, adaptersByHost } of dualHostCapabilities) {
      expect(adaptersByHost.code.length).toBeGreaterThan(0);
      expect(adaptersByHost.ctox.length).toBeGreaterThan(0);
      expect([...adaptersByHost.code, ...adaptersByHost.ctox].sort()).toEqual(
        [...manifest.supportedAdapters].sort(),
      );
    }
  });

  it("gives every dual-host capability a lock policy for all four dimensions", () => {
    expect(capabilityLockPolicies.map(({ capabilityId }) => capabilityId).sort()).toEqual(
      [...dualHostCapabilityIds].sort(),
    );
    for (const policy of capabilityLockPolicies) {
      expect(Object.keys(policy.dimensions).sort()).toEqual([...CAPABILITY_LOCK_DIMENSIONS].sort());
      for (const dimension of CAPABILITY_LOCK_DIMENSIONS) {
        const entry = policy.dimensions[dimension];
        expect(entry.codeSource).not.toBe("");
        expect(entry.reason.length).toBeGreaterThan(80);
        if (entry.enforcement === "cross-host") {
          expect(entry.ctoxSource).not.toBeNull();
        } else {
          expect(entry.ctoxSource).toBeNull();
        }
      }
    }
  });

  it("gives every dual-host capability a declared conformance coverage source", () => {
    expect(capabilityConformanceCoverage.map(({ capabilityId }) => capabilityId).sort()).toEqual(
      [...dualHostCapabilityIds].sort(),
    );
  });

  it("derives the Greppy pin instead of restating it", () => {
    expect(greppyImplementationRevision).toBe(
      "greppy@0.3.1+de078b47d1df5df7c086e4591162517328f979ec",
    );
    expect(greppyArtifactSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("canonical capability JSON", () => {
  it("is insensitive to key order and stable across calls", () => {
    expect(canonicalCapabilityJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalCapabilityJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
    expect(canonicalCapabilityJson({ a: 1, b: undefined })).toBe(canonicalCapabilityJson({ a: 1 }));
  });

  it("still distinguishes different values", () => {
    expect(canonicalCapabilityJson({ a: 1 })).not.toBe(canonicalCapabilityJson({ a: 2 }));
    expect(canonicalCapabilityJson([1, 2])).not.toBe(canonicalCapabilityJson([2, 1]));
  });

  it("projects only fields both hosts can publish", () => {
    const greppy = builtInCapabilityManifests[0]!;
    expect(Object.keys(capabilityManifestLockProjection(greppy)).sort()).toEqual([
      "id",
      "schemaVersion",
      "supportedAdapters",
      "version",
    ]);
    expect(capabilitySchemaLockProjection(greppy)).toEqual({
      inputSchema: greppy.inputSchema,
      outputSchema: greppy.outputSchema,
    });
  });
});

describe("canonical projection comparison", () => {
  it("accepts identical projections", () => {
    expect(
      compareCapabilityProjections({
        capabilityId: "web-search",
        fixtureId: "f",
        code: { outcome: "success", structuredContent: { results: [] } },
        ctox: { outcome: "success", structuredContent: { results: [] } },
      }),
    ).toEqual([]);
  });

  it("ignores key order but not content", () => {
    expect(
      compareCapabilityProjections({
        capabilityId: "web-search",
        fixtureId: "f",
        code: { outcome: "success", structuredContent: { a: 1, b: 2 } },
        ctox: { outcome: "success", structuredContent: { b: 2, a: 1 } },
      }),
    ).toEqual([]);
    expect(
      compareCapabilityProjections({
        capabilityId: "web-search",
        fixtureId: "f",
        code: { outcome: "success", structuredContent: { a: 1 } },
        ctox: { outcome: "success", structuredContent: { a: 2 } },
      }).map(({ property }) => property),
    ).toEqual(["structuredContent"]);
  });

  it("reports an outcome flip and an error-class flip separately", () => {
    expect(
      compareCapabilityProjections({
        capabilityId: "greppy",
        fixtureId: "f",
        code: { outcome: "success", structuredContent: {} },
        ctox: { outcome: "error", errorClass: "invalid-arguments" },
      }).map(({ property }) => property),
    ).toEqual(["outcome"]);
    expect(
      compareCapabilityProjections({
        capabilityId: "greppy",
        fixtureId: "f",
        code: { outcome: "error", errorClass: "execution-failed" },
        ctox: { outcome: "error", errorClass: "capability-not-granted" },
      }).map(({ property }) => property),
    ).toEqual(["errorClass"]);
  });

  it("tolerates only the differences the allow-list declares, and only with a reason", () => {
    expect(findHostPolicyDifference("web-search", "maxResponseBytes")).toBeDefined();
    expect(findHostPolicyDifference("web-search", "structuredContent")).toBeUndefined();
    expect(findHostPolicyDifference("web-search", "sessionCwd")).toBeUndefined();
    expect(findHostPolicyDifference("greppy", "sessionCwd")).toBeDefined();

    for (const difference of HOST_POLICY_DIFFERENCES) {
      expect(difference.reason.length).toBeGreaterThan(80);
      expect(difference.codeValue).not.toBe(difference.ctoxValue);
    }
  });
});
