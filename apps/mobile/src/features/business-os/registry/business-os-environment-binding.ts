import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Non-secret local relation that makes one CTOX instance the common scope for
 * Code and Business OS. Credentials remain in their existing secure stores.
 */
export interface BusinessOsEnvironmentBinding {
  readonly businessOsInstanceId: string;
  readonly environmentId: EnvironmentId;
}

export function createBusinessOsEnvironmentBinding(
  businessOsInstanceId: string,
  environmentId: EnvironmentId,
): BusinessOsEnvironmentBinding {
  if (!businessOsInstanceId.trim() || !String(environmentId).trim()) {
    throw new Error("A Workjet instance binding requires both stable identifiers.");
  }
  return Object.freeze({ businessOsInstanceId, environmentId });
}

export function environmentForBusinessOsInstance(
  bindings: readonly BusinessOsEnvironmentBinding[],
  businessOsInstanceId: string | null,
): EnvironmentId | null {
  if (!businessOsInstanceId) return null;
  return (
    bindings.find((binding) => binding.businessOsInstanceId === businessOsInstanceId)
      ?.environmentId ?? null
  );
}

export function businessOsInstanceForEnvironment(
  bindings: readonly BusinessOsEnvironmentBinding[],
  environmentId: EnvironmentId,
): string | null {
  return (
    bindings.find((binding) => binding.environmentId === environmentId)?.businessOsInstanceId ??
    null
  );
}
