import {
  type PlatformConnectionRegistration,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { BusinessOsInstanceId, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

interface MobileBusinessOsPlatformInstance {
  readonly localId: string;
  readonly authorityId: string;
  readonly label: string;
}

interface MobileBusinessOsPlatformBinding {
  readonly businessOsInstanceId: string;
  readonly environmentId: EnvironmentId;
}

let currentRegistrations: ReadonlyArray<PlatformConnectionRegistration> = [];
const listeners = new Set<(registrations: ReadonlyArray<PlatformConnectionRegistration>) => void>();

export function buildMobileBusinessOsPlatformRegistrations(input: {
  readonly instances: readonly MobileBusinessOsPlatformInstance[];
  readonly bindings: readonly MobileBusinessOsPlatformBinding[];
  readonly deviceSessionAuthorityIds: ReadonlySet<string>;
}): ReadonlyArray<PlatformConnectionRegistration> {
  const instancesByLocalId = new Map(
    input.instances.map((instance) => [instance.localId, instance]),
  );
  const registrations = new Map<EnvironmentId, PlatformConnectionRegistration>();

  for (const binding of input.bindings) {
    const instance = instancesByLocalId.get(binding.businessOsInstanceId);
    if (!instance || !input.deviceSessionAuthorityIds.has(instance.authorityId)) continue;
    registrations.set(
      binding.environmentId,
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: binding.environmentId,
          businessOsInstanceId: BusinessOsInstanceId.make(instance.authorityId),
          label: `${instance.label} · ${String(binding.environmentId).slice(0, 8)}`,
        }),
      }),
    );
  }

  return Object.freeze([...registrations.values()]);
}

/**
 * Publishes the complete current set of server-authoritative Code memberships.
 * The connection registry reconciles these runtime registrations and removes
 * stale entries. They are deliberately never written to the user connection
 * catalog, which would lose their Business-OS authority scope.
 */
export function publishMobileBusinessOsPlatformRegistrations(
  registrations: ReadonlyArray<PlatformConnectionRegistration>,
): void {
  currentRegistrations = Object.freeze([...registrations]);
  for (const listener of listeners) listener(currentRegistrations);
}

export const mobileBusinessOsPlatformRegistrations = Stream.callback<
  ReadonlyArray<PlatformConnectionRegistration>
>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener = (registrations: ReadonlyArray<PlatformConnectionRegistration>) => {
        Queue.offerUnsafe(queue, registrations);
      };
      listeners.add(listener);
      listener(currentRegistrations);
      return listener;
    }),
    (listener) => Effect.sync(() => listeners.delete(listener)),
  ).pipe(Effect.asVoid),
);
