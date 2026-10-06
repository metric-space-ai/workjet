import type { EnvironmentId } from "@workjet/contracts";
import {
  businessOsCodeScopeContainsEnvironment,
  type BusinessOsCodeScopeSnapshot,
} from "./businessOsCodeScope";

/** Local project intent is tenant-bound, even before any computer is assigned.
 * This does not grant membership or access to any remote environment. */
export function localProjectIsVisible(
  project: {
    readonly environmentId: EnvironmentId;
    readonly ctoxRegistration?: { readonly instanceId: string } | null | undefined;
  },
  context: {
    readonly scope: BusinessOsCodeScopeSnapshot;
    readonly selectedInstanceId: string | null;
    readonly primaryEnvironmentId: EnvironmentId | null;
  },
): boolean {
  const registration = project.ctoxRegistration;
  if (registration != null) {
    if (registration.instanceId !== context.selectedInstanceId) return false;
    if (
      context.selectedInstanceId !== null &&
      project.environmentId === context.primaryEnvironmentId
    )
      return true;
  }
  return businessOsCodeScopeContainsEnvironment(context.scope, project.environmentId);
}
