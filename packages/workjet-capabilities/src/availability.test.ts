import type { CapabilityManifest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  capabilityAvailabilityIds,
  resolveCapabilityAvailability,
  resolveCapabilityCatalogForHost,
  resolveCtoxInstanceCapabilityAvailability,
  resolveThreadCapabilityAvailability,
} from "./availability.ts";
import { builtInCapabilityManifests } from "./manifests.ts";
import { createCapabilityRegistry } from "./registry.ts";

const environmentId = "environment-1" as never;
const threadId = "thread-1" as never;
const instanceId = "instance-1" as never;

describe("capability availability from one catalog", () => {
  it("answers both UIs from the same catalog entries, by reference", () => {
    const code = resolveThreadCapabilityAvailability({
      environmentId,
      threadId,
      enabledCapabilityIds: ["greppy"],
    });
    const ctox = resolveCtoxInstanceCapabilityAvailability({
      instanceId,
      enabledCapabilityIds: ["web-search"],
    });

    expect(capabilityAvailabilityIds(code)).toEqual([
      "greppy",
      "web-search",
      "web-stack-browser",
      "decision-hub",
    ]);
    expect(capabilityAvailabilityIds(ctox)).toEqual(["greppy", "web-search", "web-stack-browser"]);
    for (const view of code.filter(({ manifest }) => manifest.id !== "decision-hub")) {
      // Not a copy: the very same manifest object both hosts resolve.
      expect(view.manifest).toBe(
        ctox.find(({ manifest }) => manifest.id === view.manifest.id)?.manifest,
      );
      expect(view.manifest).toBe(
        builtInCapabilityManifests.find(({ id }) => id === view.manifest.id),
      );
    }
    expect(code.map(({ host }) => host)).toEqual(code.map(() => "code"));
    expect(ctox.map(({ host }) => host)).toEqual(ctox.map(() => "ctox"));
  });

  it("keeps availability separate from activation on each target", () => {
    const code = resolveThreadCapabilityAvailability({
      environmentId,
      threadId,
      enabledCapabilityIds: ["greppy"],
    });
    expect(
      code.map(({ manifest, availability, activated }) => ({
        id: manifest.id,
        status: availability.status,
        activated,
      })),
    ).toEqual([
      { id: "greppy", status: "available", activated: true },
      { id: "web-search", status: "available", activated: false },
      { id: "web-stack-browser", status: "available", activated: false },
      { id: "decision-hub", status: "available", activated: false },
    ]);

    const ctox = resolveCtoxInstanceCapabilityAvailability({
      instanceId,
      enabledCapabilityIds: ["web-search", "web-stack-browser"],
    });
    expect(ctox.filter(({ activated }) => activated).map(({ manifest }) => manifest.id)).toEqual([
      "web-search",
      "web-stack-browser",
    ]);
  });

  it("carries the activation target the surface is scoped to", () => {
    expect(
      resolveThreadCapabilityAvailability({ environmentId, threadId, enabledCapabilityIds: [] })[0]
        ?.target,
    ).toEqual({ kind: "thread", environmentId, threadId });
    expect(
      resolveCtoxInstanceCapabilityAvailability({ instanceId, enabledCapabilityIds: [] })[0]
        ?.target,
    ).toEqual({ kind: "ctox-instance", instanceId });
    expect(
      resolveCapabilityCatalogForHost({ adapter: "t3-mcp", enabledCapabilityIds: [] })[0]?.target,
    ).toBeNull();
  });

  it("hides a capability from a host whose adapter the manifest does not expose", () => {
    const withoutCtox = builtInCapabilityManifests.map(
      (manifest): CapabilityManifest =>
        manifest.id === "greppy"
          ? {
              ...manifest,
              supportedAdapters: manifest.supportedAdapters.filter(
                (adapter) => adapter !== "ctox-business-os-mcp",
              ),
            }
          : manifest,
    );
    const registry = createCapabilityRegistry(withoutCtox);

    expect(
      capabilityAvailabilityIds(
        resolveCtoxInstanceCapabilityAvailability({
          instanceId,
          enabledCapabilityIds: ["greppy"],
          registry,
        }),
      ),
    ).toEqual(["web-search", "web-stack-browser"]);
    expect(
      capabilityAvailabilityIds(
        resolveThreadCapabilityAvailability({
          environmentId,
          threadId,
          enabledCapabilityIds: ["greppy"],
          registry,
        }),
      ),
    ).toEqual(["greppy", "web-search", "web-stack-browser", "decision-hub"]);
  });

  it("reports an incompatible pin instead of silently resolving another version", () => {
    const [view] = resolveCapabilityAvailability({
      target: null,
      adapter: "ctox-business-os-mcp",
      enabledCapabilityIds: ["greppy"],
      requestedVersions: { greppy: "2.0.0" },
    });

    expect(view?.availability).toEqual({
      capabilityId: "greppy",
      status: "incompatible",
      requestedVersion: "2.0.0",
      installedVersion: "1.0.0",
      reason: "greppy is installed at 1.0.0, not 2.0.0.",
    });
    // Still activated by policy: the instance asked for it, the host cannot serve it.
    expect(view?.activated).toBe(true);
  });
});
