import { scopeProjectRef } from "@workjet/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { useActiveWorkjetScope } from "../../activeWorkjetScope";
import { usePrimarySettings } from "../../hooks/useSettings";
import { selectProjectOverviewRef } from "../../projectOverviewSelection";
import {
  buildProjectGallery,
  visibleGalleryProjects,
  type GalleryProject,
} from "../../projectOverview";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { selectWorkjetProject, useWorkjetProjectRegistry } from "../../workjetProjectRegistry";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";

/** Must match `TRAY_OPEN_PROJECT_ACTION_PREFIX` in apps/desktop/src/tray/DesktopTrayPolicy.ts. */
const TRAY_OPEN_PROJECT_ACTION_PREFIX = "open-project:";
const TRAY_PROJECT_LIMIT = 5;

/** Same selection the project gallery card performs on click. */
function openGalleryProject(instanceId: string | null, project: GalleryProject): void {
  if (project.native && instanceId !== null) {
    if (selectWorkjetProject(instanceId, project.id)) selectProjectOverviewRef(instanceId, null);
    return;
  }
  const local = project.local;
  if (local === null) return;
  if (instanceId !== null && selectWorkjetProject(instanceId, local.id)) {
    selectProjectOverviewRef(instanceId, null);
    return;
  }
  if (instanceId !== null) selectWorkjetProject(instanceId, null);
  selectProjectOverviewRef(instanceId, scopeProjectRef(local.environmentId, local.id));
}

/**
 * Desktop only: hands the gallery's first five active projects to the
 * menu-bar/tray menu and opens a project when the tray asks for it.
 */
export function DesktopTrayProjects() {
  const projects = useProjects();
  const threads = useThreadShells();
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  const { selectedInstanceId } = useActiveWorkjetScope();
  const registry = useWorkjetProjectRegistry(selectedInstanceId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();

  const gallery = useMemo(
    () =>
      visibleGalleryProjects(
        buildProjectGallery({
          projects: sortScopedProjectsForSidebar(projects, threads, "updated_at"),
          nativeProjects: registry.projects,
          instanceId: selectedInstanceId,
          primaryEnvironmentId,
          computers,
        }),
      ),
    [projects, threads, registry.projects, selectedInstanceId, primaryEnvironmentId, computers],
  );
  const signature = useMemo(
    () =>
      JSON.stringify(
        gallery
          .slice(0, TRAY_PROJECT_LIMIT)
          .map((project) => ({ key: project.key, title: project.title })),
      ),
    [gallery],
  );

  useEffect(() => {
    const setTrayProjects = window.desktopBridge?.setTrayProjects;
    if (typeof setTrayProjects !== "function") return;
    void setTrayProjects(JSON.parse(signature)).catch(() => undefined);
  }, [signature]);

  const galleryRef = useRef(gallery);
  useEffect(() => {
    galleryRef.current = gallery;
  }, [gallery]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    return onMenuAction((action) => {
      if (!action.startsWith(TRAY_OPEN_PROJECT_ACTION_PREFIX)) return;
      const key = action.slice(TRAY_OPEN_PROJECT_ACTION_PREFIX.length);
      const project = galleryRef.current.find((candidate) => candidate.key === key);
      if (project === undefined) return;
      openGalleryProject(selectedInstanceId, project);
      void navigate({ to: "/" });
    });
  }, [navigate, selectedInstanceId]);

  return null;
}
