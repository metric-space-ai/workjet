import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Non-secret local membership that makes one Code machine/environment part of
 * a CTOX instance. One instance may own several Code environments, while each
 * environment belongs to exactly one instance. Credentials remain in their
 * existing secure stores.
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

export function environmentsForBusinessOsInstance(
  bindings: readonly BusinessOsEnvironmentBinding[],
  businessOsInstanceId: string | null,
): readonly EnvironmentId[] {
  if (!businessOsInstanceId) return [];
  return bindings
    .filter((binding) => binding.businessOsInstanceId === businessOsInstanceId)
    .map((binding) => binding.environmentId);
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
