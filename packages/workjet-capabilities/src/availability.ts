import type {
  CapabilityActivationTarget,
  CapabilityAdapter,
  CapabilityAvailability,
  CapabilityCtoxInstanceActivationTarget,
  CapabilityManifest,
  CapabilityThreadActivationTarget,
  WorkjetCapabilityId,
} from "@t3tools/contracts";

import { capabilityHostForAdapter, type CapabilityHostId } from "./dualHost.ts";
import { defaultCapabilityRegistry, type CapabilityRegistry } from "./registry.ts";

/**
 * ONE CATALOG, BOTH UIS.
 *
 * The Code composer's per-thread toggles and Business OS's instance-policy
 * controls are the same question asked about two different activation targets:
 * "which capabilities does this catalog offer this host, and which are active
 * here?". This module answers it once.
 *
 * The view deliberately carries the MANIFEST ITSELF, not copies of its display
 * name, description, or schemas. A surface that rendered its own label would be
 * a second place capability metadata has to be kept correct, which is exactly
 * what the plan forbids.
 */

export interface CapabilityAvailabilityView {
  /** The catalog entry, by reference. Never a copy of its metadata. */
  readonly manifest: CapabilityManifest;
  readonly host: CapabilityHostId;
  readonly adapter: CapabilityAdapter;
  /**
   * The activation target these views describe, when the surface scopes to one.
   * The Code composer already renders inside a single thread, so it asks the
   * host-level question with `null` rather than restating the thread identity.
   */
  readonly target: CapabilityActivationTarget | null;
  readonly availability: CapabilityAvailability;
  /** Availability is not activation: an installed capability can be off here. */
  readonly activated: boolean;
}

export interface ResolveCapabilityAvailabilityInput {
  readonly target: CapabilityActivationTarget | null;
  readonly adapter: CapabilityAdapter;
  readonly enabledCapabilityIds: ReadonlyArray<string>;
  /**
   * Version each capability is requested at, when the caller pins one. Absent
   * entries resolve at the installed version, which is what both UIs do today.
   */
  readonly requestedVersions?: Readonly<Record<string, string>>;
  readonly registry?: CapabilityRegistry;
}

const availabilityFor = (
  manifest: CapabilityManifest,
  adapter: CapabilityAdapter,
  requestedVersion: string | undefined,
): CapabilityAvailability => {
  const requested = requestedVersion ?? manifest.version;
  if (!manifest.supportedAdapters.includes(adapter)) {
    return {
      capabilityId: manifest.id,
      status: "unavailable",
      requestedVersion: requested,
      installedVersion: manifest.version,
      reason: `${manifest.id} is installed but exposes no ${adapter} adapter.`,
    };
  }
  if (requested !== manifest.version) {
    return {
      capabilityId: manifest.id,
      status: "incompatible",
      requestedVersion: requested,
      installedVersion: manifest.version,
      reason: `${manifest.id} is installed at ${manifest.version}, not ${requested}.`,
    };
  }
  return {
    capabilityId: manifest.id,
    status: "available",
    requestedVersion: requested,
    installedVersion: manifest.version,
    reason: null,
  };
};

/**
 * Every capability the catalog offers this host, in catalog order, with its
 * availability and its activation on this target.
 */
export const resolveCapabilityAvailability = (
  input: ResolveCapabilityAvailabilityInput,
): ReadonlyArray<CapabilityAvailabilityView> => {
  const registry = input.registry ?? defaultCapabilityRegistry;
  const host = capabilityHostForAdapter(input.adapter);
  const activated = new Set(input.enabledCapabilityIds);

  return registry
    .list()
    .filter((manifest) => manifest.supportedAdapters.includes(input.adapter))
    .map((manifest) => ({
      manifest,
      host,
      adapter: input.adapter,
      target: input.target,
      availability: availabilityFor(
        manifest,
        input.adapter,
        input.requestedVersions?.[manifest.id],
      ),
      activated: activated.has(manifest.id),
    }));
};

/**
 * The Code host's per-thread question. `enabledCapabilityIds` comes straight
 * from the thread's `WorkjetThreadConfig`.
 */
export const resolveThreadCapabilityAvailability = (input: {
  readonly environmentId: CapabilityThreadActivationTarget["environmentId"];
  readonly threadId: CapabilityThreadActivationTarget["threadId"];
  readonly enabledCapabilityIds: ReadonlyArray<string>;
  readonly adapter?: CapabilityAdapter;
  readonly registry?: CapabilityRegistry;
}): ReadonlyArray<CapabilityAvailabilityView> =>
  resolveCapabilityAvailability({
    target: {
      kind: "thread",
      environmentId: input.environmentId,
      threadId: input.threadId,
    },
    adapter: input.adapter ?? "t3-mcp",
    enabledCapabilityIds: input.enabledCapabilityIds,
    ...(input.registry ? { registry: input.registry } : {}),
  });

/**
 * The Business OS host's per-instance question. `enabledCapabilityIds` is the
 * CTOX instance policy; the CTOX surface renders controls or read-only status
 * from these views without restating a single field of capability metadata.
 */
export const resolveCtoxInstanceCapabilityAvailability = (input: {
  readonly instanceId: CapabilityCtoxInstanceActivationTarget["instanceId"];
  readonly enabledCapabilityIds: ReadonlyArray<string>;
  readonly adapter?: CapabilityAdapter;
  readonly registry?: CapabilityRegistry;
}): ReadonlyArray<CapabilityAvailabilityView> =>
  resolveCapabilityAvailability({
    target: { kind: "ctox-instance", instanceId: input.instanceId },
    adapter: input.adapter ?? "ctox-business-os-mcp",
    enabledCapabilityIds: input.enabledCapabilityIds,
    ...(input.registry ? { registry: input.registry } : {}),
  });

/**
 * The host-level question, for a surface that is already scoped to one target.
 * The Code composer's Tools menu uses this so its labels, descriptions, and
 * membership all come from the catalog.
 */
export const resolveCapabilityCatalogForHost = (input: {
  readonly adapter: CapabilityAdapter;
  readonly enabledCapabilityIds: ReadonlyArray<string>;
  readonly registry?: CapabilityRegistry;
}): ReadonlyArray<CapabilityAvailabilityView> =>
  resolveCapabilityAvailability({
    target: null,
    adapter: input.adapter,
    enabledCapabilityIds: input.enabledCapabilityIds,
    ...(input.registry ? { registry: input.registry } : {}),
  });

export const capabilityAvailabilityIds = (
  views: ReadonlyArray<CapabilityAvailabilityView>,
): ReadonlyArray<WorkjetCapabilityId> => views.map(({ manifest }) => manifest.id);
