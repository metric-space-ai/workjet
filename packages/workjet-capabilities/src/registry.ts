import {
  CapabilityIncompatibleVersionError,
  CapabilityUnknownIdError,
  type CapabilityAdapter,
  type CapabilityManifestV1,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { builtInCapabilityManifests } from "./manifests.ts";

export interface CapabilityResolutionRequest {
  readonly capabilityId: string;
  readonly requestedVersion: string;
}

export interface CapabilityRegistry {
  readonly list: () => ReadonlyArray<CapabilityManifestV1>;
  readonly find: (capabilityId: string) => CapabilityManifestV1 | undefined;
  readonly resolve: (
    request: CapabilityResolutionRequest,
  ) => Effect.Effect<
    CapabilityManifestV1,
    CapabilityUnknownIdError | CapabilityIncompatibleVersionError
  >;
  readonly listForAdapter: (adapter: CapabilityAdapter) => ReadonlyArray<CapabilityManifestV1>;
  readonly resolveEnabled: (
    capabilityIds: ReadonlyArray<string>,
    adapter: CapabilityAdapter,
  ) => ReadonlyArray<CapabilityManifestV1>;
}

export const createCapabilityRegistry = (
  manifests: ReadonlyArray<CapabilityManifestV1>,
): CapabilityRegistry => {
  const installed = [...manifests];
  const firstById = new Map<string, CapabilityManifestV1>();

  for (const manifest of installed) {
    if (!firstById.has(manifest.id)) {
      firstById.set(manifest.id, manifest);
    }
  }

  const find = (capabilityId: string): CapabilityManifestV1 | undefined =>
    firstById.get(capabilityId);

  return {
    list: () => [...installed],
    find,
    resolve: ({ capabilityId, requestedVersion }) => {
      const manifest = find(capabilityId);

      if (manifest === undefined) {
        return Effect.fail(new CapabilityUnknownIdError({ capabilityId }));
      }

      if (manifest.version !== requestedVersion) {
        return Effect.fail(
          new CapabilityIncompatibleVersionError({
            capabilityId: manifest.id,
            requestedVersion,
            installedVersion: manifest.version,
          }),
        );
      }

      return Effect.succeed(manifest);
    },
    listForAdapter: (adapter) =>
      installed.filter((manifest) => manifest.supportedAdapters.includes(adapter)),
    resolveEnabled: (capabilityIds, adapter) => {
      const seen = new Set<string>();
      const resolved: Array<CapabilityManifestV1> = [];

      for (const capabilityId of capabilityIds) {
        if (seen.has(capabilityId)) {
          continue;
        }
        seen.add(capabilityId);

        const manifest = find(capabilityId);
        if (manifest !== undefined && manifest.supportedAdapters.includes(adapter)) {
          resolved.push(manifest);
        }
      }

      return resolved;
    },
  };
};

export const defaultCapabilityRegistry = createCapabilityRegistry(builtInCapabilityManifests);
