import type { EnvironmentId } from "@t3tools/contracts";

export function isThreadEnvironmentInActiveBusinessOsScope(input: {
  readonly environmentId: EnvironmentId | null;
  readonly activeEnvironmentIds: readonly EnvironmentId[];
  readonly hasEnvironmentBindings: boolean;
}): boolean {
  return (
    input.environmentId === null ||
    !input.hasEnvironmentBindings ||
    input.activeEnvironmentIds.includes(input.environmentId)
  );
}
