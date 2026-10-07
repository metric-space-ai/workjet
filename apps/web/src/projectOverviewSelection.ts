import type { scopeProjectRef } from "@workjet/client-runtime/environment";
import { useSyncExternalStore } from "react";

type ProjectRef = ReturnType<typeof scopeProjectRef>;

/** UI selection only; project records, registration and permissions remain native. */
export class ProjectOverviewSelectionStore {
  private readonly selections = new Map<string | null, ProjectRef>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  read(instanceId: string | null): ProjectRef | null {
    return this.selections.get(instanceId) ?? null;
  }

  select(instanceId: string | null, project: ProjectRef | null): void {
    const previous = this.read(instanceId);
    if (
      previous?.environmentId === project?.environmentId &&
      previous?.projectId === project?.projectId
    )
      return;
    if (project === null) this.selections.delete(instanceId);
    else this.selections.set(instanceId, project);
    for (const listener of this.listeners) listener();
  }
}

const selection = new ProjectOverviewSelectionStore();
export const selectProjectOverviewRef = (instanceId: string | null, project: ProjectRef | null) =>
  selection.select(instanceId, project);

export function useProjectOverviewRef(instanceId: string | null): ProjectRef | null {
  return useSyncExternalStore(
    selection.subscribe,
    () => selection.read(instanceId),
    () => null,
  );
}
