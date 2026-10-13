import { ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { readActiveWorkjetScope, useActiveWorkjetScope } from "../../activeWorkjetScope";
import { useProjectKpiSettings } from "../../hooks/useProjectKpiSettings";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn, newCommandId } from "../../lib/utils";
import { buildProjectGallery, type GalleryProject } from "../../projectOverview";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { configureWorkjetProject, workjetUiLanguage } from "../../workjetProjectControl";
import {
  refreshWorkjetProjectRegistry,
  useWorkjetProjectRegistry,
} from "../../workjetProjectRegistry";
import { ProjectOverviewEditor, type ProjectConfigurationValues } from "../ProjectOverviewEditor";
import { ProjectSupervisorLumaField } from "../ProjectSupervisorLumaField";
import { Row } from "../ui/row";
import { SettingsPageContainer, SettingsSection, useSettingsEmbedded } from "./settingsLayout";

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

const text = () =>
  workjetUiLanguage() === "en"
    ? {
        settings: "Meeting, budget and Supervisor",
      }
    : {
        settings: "Regeltermin, Budget und Supervisor",
      };

/** One row in the plain project list for an instance project without a local copy (#492). */
export function InstanceProjectRow({
  project,
  open,
  onToggle,
}: {
  readonly project: GalleryProject;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const key = instanceProjectSettingsKey(project.id);
  return (
    <Row
      name={
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-workjet-action={`project.settings:${key}`}
        >
          <span className="truncate">{project.title}</span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      }
    />
  );
}

/** Instance-side settings (metadata, Regeltermin, Supervisor, KPIs) without a local copy. */
export function InstanceProjectDetail({
  instanceId,
  project,
}: {
  readonly instanceId: string;
  readonly project: GalleryProject;
}) {
  const configuration = project.configuration;
  const kpis = useProjectKpiSettings(instanceId, configuration?.id);
  const saveConfiguration = useCallback(
    async (values: ProjectConfigurationValues): Promise<boolean> => {
      if (configuration === undefined) return false;
      if (readActiveWorkjetScope().selectedInstanceId !== instanceId) return false;
      const result = await configureWorkjetProject(instanceId, {
        action: "project.configure",
        commandId: newCommandId(),
        projectId: configuration.id,
        title: project.title,
        ...values,
      });
      if (result._tag !== "completed" || result.response.action !== "project.configure")
        return false;
      refreshWorkjetProjectRegistry(instanceId);
      return true;
    },
    [configuration, instanceId, project.title],
  );
  const t = text();
  const embedded = useSettingsEmbedded();
  return (
    <SettingsPageContainer>
      {embedded ? null : (
        <h2 className="min-w-0 break-words px-1 text-[22px] font-semibold">{project.title}</h2>
      )}
      <SettingsSection title={t.settings}>
        <div className="px-3 py-3 sm:px-4" data-workjet-project-settings-overview="">
          <ProjectOverviewEditor
            key={project.key}
            onCancel={embedded?.onClose}
            overview={null}
            configuration={configuration}
            onSaveConfiguration={saveConfiguration}
            renderLumaField={(props) => <ProjectSupervisorLumaField {...props} />}
            kpis={kpis.kpis}
            onSaveKpis={kpis.save}
            kpisLoadFailed={kpis.loadFailed}
            // Website, Git-Quelle und Regeltermin speichert project.configure; nur das Budget
            // liegt in der lokalen Projektübersicht und braucht eine Arbeitskopie.
            onSave={async (next) => next.tokenBudget?.limitBillions == null}
          />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
