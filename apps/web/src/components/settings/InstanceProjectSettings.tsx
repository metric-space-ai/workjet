import { useMemo } from "react";

import { useActiveWorkjetScope } from "../../activeWorkjetScope";
import { usePrimarySettings } from "../../hooks/useSettings";
import { buildProjectGallery, type GalleryProject } from "../../projectOverview";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { workjetUiLanguage } from "../../workjetProjectControl";
import { useWorkjetProjectRegistry } from "../../workjetProjectRegistry";
import { Row } from "../ui/row";

/** Route key for an instance project without a local working copy on this machine. */
export const INSTANCE_PROJECT_KEY_PREFIX = "instance:";

export function instanceProjectSettingsKey(projectId: string): string {
  return INSTANCE_PROJECT_KEY_PREFIX + projectId;
}

/** Native projects of the active instance that have no local project on this machine. */
export function instanceOnlyProjects(gallery: readonly GalleryProject[]): GalleryProject[] {
  return gallery
    .filter((project) => project.native && project.local === null && project.configuration)
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

export function useInstanceOnlyProjects(): {
  readonly instanceId: string | null;
  readonly projects: readonly GalleryProject[];
} {
  const { selectedInstanceId } = useActiveWorkjetScope();
  const registry = useWorkjetProjectRegistry(selectedInstanceId);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  const result = useMemo(
    () =>
      selectedInstanceId === null
        ? []
        : instanceOnlyProjects(
            buildProjectGallery({
              projects,
              nativeProjects: registry.projects,
              instanceId: selectedInstanceId,
              primaryEnvironmentId,
              computers,
            }),
          ),
    [computers, primaryEnvironmentId, projects, registry.projects, selectedInstanceId],
  );
  return { instanceId: selectedInstanceId, projects: result };
}

/** One row in the plain project list for an instance project without a local copy (#492). */
export function InstanceProjectRow({
  project,
  onOpenCard,
}: {
  readonly project: GalleryProject;
  /** Regeltermin, Budget und Supervisor leben auf der Projektkarte (#569). */
  readonly onOpenCard: () => void;
}) {
  const key = instanceProjectSettingsKey(project.id);
  return (
    <Row
      name={
        <button
          type="button"
          onClick={onOpenCard}
          className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-workjet-action={`project.card:${key}`}
        >
          <span className="truncate">{project.title}</span>
        </button>
      }
      status="off"
      statusLabel={
        workjetUiLanguage() === "en" ? "No working copy here" : "Keine Arbeitskopie hier"
      }
      meta={
        workjetUiLanguage() === "en"
          ? "In CTOX · no working copy on this computer"
          : "In CTOX · keine Arbeitskopie auf diesem Rechner"
      }
    />
  );
}
