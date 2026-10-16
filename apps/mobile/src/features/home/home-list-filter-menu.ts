import type { EnvironmentId, SidebarThreadSortOrder } from "@workjet/contracts";

import type { HomeProjectSortOrder } from "./homeThreadList";
import { PROJECT_SORT_OPTIONS, THREAD_SORT_OPTIONS } from "./home-list-options";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly allowAllEnvironments?: boolean;
  readonly environmentMenuTitle?: string;
  readonly allEnvironmentsLabel?: string;
  readonly allEnvironmentsSubtitle?: string;
  /** False hides the sort/group submenus. Thread List v2 uses a fixed
      creation-order layout, so offering those controls while it silently
      ignores them would be a lie; the environment filter still applies. */
  readonly listOrganization?: boolean;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  items.push({
    type: "submenu",
    title: props.environmentMenuTitle ?? "Rechner",
    items: [
      ...(props.allowAllEnvironments === false
        ? []
        : [
            {
              type: "action" as const,
              title: props.allEnvironmentsLabel ?? "Alle Rechner",
              subtitle: props.allEnvironmentsSubtitle ?? "Von allen Rechnern",
              state: props.selectedEnvironmentId === null ? ("on" as const) : ("off" as const),
              onPress: () => props.onEnvironmentChange(null),
            },
          ]),
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        state:
          props.selectedEnvironmentId === environment.environmentId
            ? ("on" as const)
            : ("off" as const),
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Projekt",
      items: [
        {
          type: "action",
          title: "Alle Projekte",
          subtitle: "Aus allen Projekten",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  if (props.listOrganization !== false) {
    items.push(
      {
        type: "submenu",
        title: "Projekte sortieren",
        items: PROJECT_SORT_OPTIONS.map((option) => ({
          type: "action",
          title: option.label,
          state: props.projectSortOrder === option.value ? "on" : "off",
          onPress: () => props.onProjectSortOrderChange(option.value),
        })),
      },
      {
        type: "submenu",
        title: "Unterhaltungen sortieren",
        items: THREAD_SORT_OPTIONS.map((option) => ({
          type: "action",
          title: option.label,
          state: props.threadSortOrder === option.value ? "on" : "off",
          onPress: () => props.onThreadSortOrderChange(option.value),
        })),
      },
    );
  }

  return {
    title: "Listenoptionen",
    items,
  };
}
