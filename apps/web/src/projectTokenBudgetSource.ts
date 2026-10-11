import type { CtoxWorkjetProjectProjection, WorkjetComputer } from "@workjet/contracts";
import type { GalleryLocalProject } from "./projectOverview";
import { resolveProjectHistoryBindings } from "./workjetProjectIdentity";

const editorSaves = new Set<string>();
/** Keep the editor's two acknowledged writes together before following its source echo. */
export function deferTokenBudgetCalendarSource(projectId: string | undefined) {
  if (projectId !== undefined) editorSaves.add(projectId);
  return () => {
    if (projectId !== undefined) editorSaves.delete(projectId);
  };
}

/** Follow confirmed project-source changes, including explicit removal of a meeting. */
export function tokenBudgetCalendarUpdates(input: {
  readonly instanceId: string;
  readonly nativeProjects: readonly CtoxWorkjetProjectProjection[];
  readonly projects: readonly GalleryLocalProject[];
  readonly computers: readonly WorkjetComputer[];
}) {
  const bindings = resolveProjectHistoryBindings(input);
  return input.projects.flatMap((project) => {
    const binding = bindings.find(
      (entry) => entry.environmentId === project.environmentId && entry.projectId === project.id,
    );
    const source = input.nativeProjects.find((entry) => entry.id === binding?.nativeProjectId);
    const budget = project.overview?.tokenBudget ?? {
      limitBillions: null,
      revision: 0,
      jourFixe: null,
    };
    // An older source without configuration is unknown, not a cleared meeting.
    if (
      !source ||
      editorSaves.has(source.id) ||
      source.jourFixe === undefined ||
      JSON.stringify(budget.jourFixe) === JSON.stringify(source.jourFixe)
    )
      return [];
    return [
      {
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          expectedTokenBudgetRevision: budget.revision,
          overview: {
            ...(project.overview ?? { websiteUrl: null, slots: [null, null, null] as const }),
            tokenBudget: { ...budget, jourFixe: source.jourFixe },
          },
        },
      },
    ];
  });
}
