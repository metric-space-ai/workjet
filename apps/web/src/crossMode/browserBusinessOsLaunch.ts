import type { WorkjetCrossModeResolveBrowserOpsRpcResult } from "@workjet/contracts";

/** This URL carries an address only. CTOX authenticates and authorizes its own user. */
export function browserBusinessOsLaunchUrl(
  target: WorkjetCrossModeResolveBrowserOpsRpcResult,
): string {
  const url = new URL(`/workjet/open/${encodeURIComponent(target.instanceId)}`, "https://ctox.dev");
  if (url.pathname !== `/workjet/open/${encodeURIComponent(target.instanceId)}`) {
    throw new Error("Ungültige Instanzadresse.");
  }
  if (target._tag === "linked-object") {
    const ref = target.ctox;
    if (ref.instanceId !== target.instanceId)
      throw new Error("Die Instanzzuordnung hat sich geändert.");
    url.searchParams.set("app", ref.moduleId);
    if (ref.moduleId === "ctox" && (ref.objectKind === "task" || ref.objectKind === "command")) {
      url.searchParams.set("kind", ref.objectKind);
      url.searchParams.set("object", ref.objectId);
    } else if (
      !((ref.objectKind === "app" || ref.objectKind === "module") && ref.objectId === ref.moduleId)
    ) {
      throw new Error("Dieser Business-OS-Verweis kann noch nicht im Browser geöffnet werden.");
    }
  }
  return url.toString();
}
