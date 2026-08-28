import type { CtoxManagedInstance } from "@t3tools/contracts";

/**
 * Keep opaque backend authority identifiers out of regular product chrome.
 * A real operator-provided or workspace name always wins; the fallback stays
 * stable and scannable without pretending that the identifier is a name.
 */
export function ctoxInstanceDisplayTitle(
  instance: Pick<CtoxManagedInstance, "displayName">,
  workspaceName: string | null = null,
): string {
  if (workspaceName !== null && workspaceName.trim() !== "") return workspaceName;
  const displayName = instance.displayName.trim();
  if (/^biz_[a-z0-9-]+$/i.test(displayName)) {
    const shortId = displayName.slice(4).split("-")[0]?.slice(0, 8) || displayName.slice(4, 12);
    return `CTOX Backend · ${shortId}`;
  }
  return displayName;
}
