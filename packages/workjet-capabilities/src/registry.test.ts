import { describe, expect, it } from "@effect/vitest";
import type { CapabilityManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { builtInCapabilityManifests } from "./manifests.ts";
import { createCapabilityRegistry, defaultCapabilityRegistry } from "./registry.ts";

const withoutAdapter = (
  manifest: CapabilityManifest,
  excluded: "t3-mcp" | "t3-prompt" | "ctox-business-os-mcp" | "ctox-business-command",
): CapabilityManifest => ({
  ...manifest,
  supportedAdapters: manifest.supportedAdapters.filter((adapter) => adapter !== excluded),
});

describe("capability registry", () => {
  it("lists and finds manifests without changing input order", () => {
    expect(defaultCapabilityRegistry.list()).toEqual(builtInCapabilityManifests);
    expect(defaultCapabilityRegistry.find("web-search")).toBe(builtInCapabilityManifests[1]);
    expect(defaultCapabilityRegistry.find("not-installed")).toBeUndefined();
  });

  it.effect("resolves only the exact installed version", () =>
    Effect.gen(function* () {
      const manifest = yield* defaultCapabilityRegistry.resolve({
        capabilityId: "greppy",
        requestedVersion: "1.0.0",
      });

      expect(manifest).toBe(builtInCapabilityManifests[0]);
    }),
  );

  it.effect("fails unknown IDs with the typed contract error", () =>
    Effect.gen(function* () {
      const error = yield* defaultCapabilityRegistry
        .resolve({ capabilityId: "not-installed", requestedVersion: "1.0.0" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "CapabilityUnknownIdError",
        capabilityId: "not-installed",
      });
    }),
  );

  it.effect("fails non-exact versions with installed and requested versions", () =>
    Effect.gen(function* () {
      const error = yield* defaultCapabilityRegistry
        .resolve({ capabilityId: "web-search", requestedVersion: "1.0.1" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "CapabilityIncompatibleVersionError",
        capabilityId: "web-search",
        requestedVersion: "1.0.1",
        installedVersion: "1.0.0",
      });
    }),
  );

  it("filters manifests by adapter in registry order", () => {
    const source = [
      builtInCapabilityManifests[0],
      withoutAdapter(builtInCapabilityManifests[1]!, "t3-prompt"),
      builtInCapabilityManifests[2],
    ].filter((manifest): manifest is CapabilityManifest => manifest !== undefined);
    const registry = createCapabilityRegistry(source);

    expect(registry.listForAdapter("t3-prompt").map(({ id }) => id)).toEqual([
      "greppy",
      "web-stack-browser",
    ]);
  });

  it("resolves enabled IDs in first-request order, de-duplicating and filtering", () => {
    const registry = createCapabilityRegistry([
      builtInCapabilityManifests[0]!,
      withoutAdapter(builtInCapabilityManifests[1]!, "ctox-business-command"),
      builtInCapabilityManifests[2]!,
    ]);
    const requested = [
      "web-stack-browser",
      "web-search",
      "web-stack-browser",
      "unknown",
      "greppy",
      "greppy",
    ];

    expect(registry.resolveEnabled(requested, "ctox-business-command").map(({ id }) => id)).toEqual(
      ["web-stack-browser", "greppy"],
    );
    expect(requested).toEqual([
      "web-stack-browser",
      "web-search",
      "web-stack-browser",
      "unknown",
      "greppy",
      "greppy",
    ]);
  });

  it("does not mutate source collections or expose its internal list", () => {
    const source = [...builtInCapabilityManifests];
    const original = [...source];
    const registry = createCapabilityRegistry(source);
    const listed = registry.list() as Array<CapabilityManifest>;

    listed.reverse();
    source.reverse();

    expect(registry.list()).toEqual(original);
    expect(registry.list()).not.toBe(listed);
  });
});
