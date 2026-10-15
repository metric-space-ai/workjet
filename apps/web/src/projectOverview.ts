import { workjetUiLanguage } from "./workjetProjectControl";
import {
  ProjectOverview,
  type CtoxWorkjetProjectProjection,
  type CtoxWorkjetProjectMetadataProjection,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type WorkjetComputer,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { resolveProjectHistoryBindings } from "./workjetProjectIdentity";

export type OverviewSlotDraft = {
  kind: "empty" | "text" | "link" | "updated" | "metric";
  label: string;
  value: string;
  unit: string;
};
export type OverviewDraft = {
  archived?: boolean | undefined;
  supervisorTick?: ProjectOverview["supervisorTick"];
  meetingPreparation?: ProjectOverview["meetingPreparation"];
  regularMeeting?: ProjectOverview["regularMeeting"];
  repositoryUrl?: string | undefined;
  websiteUrl: string;
  /** True once the editor consciously emptied the website field; survives later saves. */
  websiteUrlCleared: boolean;
  slots: [OverviewSlotDraft, OverviewSlotDraft, OverviewSlotDraft];
};
const emptySlot = (): OverviewSlotDraft => ({ kind: "empty", label: "", value: "", unit: "" });
export function overviewDraft(overview: ProjectOverview | null | undefined): OverviewDraft {
  const draft = (index: number): OverviewSlotDraft => {
    const slot = overview?.slots[index];
    if (!slot) return emptySlot();
    return {
      kind: slot.kind,
      label: slot.label,
      value:
        slot.kind === "text"
          ? slot.value
          : slot.kind === "link"
            ? slot.url
            : slot.kind === "metric"
              ? String(slot.value)
              : "",
      unit: slot.kind === "metric" ? slot.unit : "",
    };
  };
  return {
    archived: overview?.archived,
    supervisorTick: overview?.supervisorTick,
    meetingPreparation: overview?.meetingPreparation,
    regularMeeting: overview?.regularMeeting,
    repositoryUrl:
      overview?.repositoryUrl === undefined ? undefined : (overview.repositoryUrl ?? ""),
    websiteUrl: overview?.websiteUrl ?? "",
    websiteUrlCleared: overview?.websiteUrlCleared === true,
    slots: [draft(0), draft(1), draft(2)],
  };
}
/** The editor's website field: entering a URL clears the marker, emptying it sets the marker. */
export function websiteDraftChange(current: OverviewDraft, value: string): OverviewDraft {
  return { ...current, websiteUrl: value, websiteUrlCleared: value.trim() === "" };
}
const decodeOverview = Schema.decodeUnknownSync(ProjectOverview);
export function decodeOverviewDraft(draft: OverviewDraft): ProjectOverview {
  const slot = (item: OverviewSlotDraft) => {
    if (item.kind === "empty") return null;
    if (item.kind === "updated") return { kind: item.kind, label: item.label };
    if (item.kind === "link") return { kind: item.kind, label: item.label, url: item.value };
    if (item.kind === "text") return { kind: item.kind, label: item.label, value: item.value };
    if (item.value.trim() === "") throw new Error("Enter a number for each metric.");
    return { kind: item.kind, label: item.label, value: Number(item.value), unit: item.unit };
  };
  const websiteUrl = draft.websiteUrl.trim() || null;
  return decodeOverview({
    ...(draft.archived === undefined ? {} : { archived: draft.archived }),
    ...(draft.supervisorTick === undefined ? {} : { supervisorTick: draft.supervisorTick }),
    ...(draft.meetingPreparation === undefined
      ? {}
      : { meetingPreparation: draft.meetingPreparation }),
    ...(draft.regularMeeting === undefined ? {} : { regularMeeting: draft.regularMeeting }),
    ...(draft.repositoryUrl === undefined
      ? {}
      : { repositoryUrl: draft.repositoryUrl.trim() || null }),
    websiteUrl,
    // Only an empty website can be consciously cleared; a set URL drops the marker.
    ...(websiteUrl === null && draft.websiteUrlCleared ? { websiteUrlCleared: true } : {}),
    slots: draft.slots.map(slot),
  });
}
export function projectUpdateAge(
  updatedAt: string | null,
  now: number = Date.now(),
  language: "de" | "en" = workjetUiLanguage() === "en" ? "en" : "de",
): string {
  const en = language === "en";
  if (updatedAt === null || !Number.isFinite(Date.parse(updatedAt))) {
    return en ? "Not available" : "Nicht verfügbar";
  }
  const minutes = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60_000));
  if (minutes < 1) return en ? "Just now" : "Gerade eben";
  if (minutes < 60) return en ? `${minutes}m ago` : `vor ${minutes} Min.`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    return en ? `${hours}h ago` : `vor ${hours} Std.`;
  }
  const days = Math.floor(minutes / 1440);
  return en ? `${days}d ago` : days === 1 ? "vor 1 Tag" : `vor ${days} Tagen`;
}
export type GalleryLocalProject = Pick<
  OrchestrationProjectShell,
  | "id"
  | "title"
  | "updatedAt"
  | "overview"
  | "ctoxRegistration"
  | "faviconPath"
  | "repositoryIdentity"
> & {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot?: string | null | undefined;
};
export type GalleryProject = {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly local: GalleryLocalProject | null;
  readonly native: boolean;
  readonly configuration?: CtoxWorkjetProjectMetadataProjection;
};
export type GalleryProjectStatistics = {
  readonly chatCount: number | null;
  readonly activeChatCount: number | null;
  readonly lastActivityAt: string | null;
};
/** Count only the identity-bound local project; missing histories are unknown. */
export function resolveGalleryProjectStatistics(
  project: GalleryProject,
  threads: readonly {
    readonly environmentId: string;
    readonly projectId: string;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
    readonly deletedAt?: string | null | undefined;
    readonly session: { readonly status: string } | null;
  }[],
  ready: boolean,
): GalleryProjectStatistics {
  const local = project.local;
  if (local === null || !ready)
    return { chatCount: null, activeChatCount: null, lastActivityAt: local?.updatedAt ?? null };
  const own = threads.filter(
    (thread) =>
      thread.environmentId === local.environmentId &&
      thread.projectId === local.id &&
      thread.deletedAt == null,
  );
  const times = [local.updatedAt, ...own.map((thread) => thread.updatedAt)].filter((value) =>
    Number.isFinite(Date.parse(value)),
  );
  return {
    chatCount: own.length,
    activeChatCount: own.filter(
      (thread) =>
        thread.archivedAt === null &&
        (thread.session?.status === "running" || thread.session?.status === "starting"),
    ).length,
    lastActivityAt: times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
  };
}
/** Saved metadata wins, including an explicitly cleared website. Domain-named native projects can preview their website before a local history exists. */

/** The starting overview for projects without one: domain-titled projects fall back to their website. */
export function fallbackProjectOverview(title: string): ProjectOverview {
  const name = title.trim().toLowerCase();
  const isDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name);
  return {
    websiteUrl: isDomain ? `https://${name}` : null,
    slots: [null, null, null],
  };
}
export function resolveGalleryProjectOverview(project: GalleryProject): ProjectOverview {
  const fallback = fallbackProjectOverview(project.title);
  const stored = project.local?.overview;
  // An unmarked null website was never set (legacy or automatic writes), so the
  // domain fallback applies; only the editor's explicit clear marker suppresses it.
  const saved =
    stored == null
      ? fallback
      : stored.websiteUrl !== null || stored.websiteUrlCleared === true
        ? stored
        : { ...stored, websiteUrl: fallback.websiteUrl };
  if (
    project.configuration?.repoUrl === undefined &&
    project.configuration?.publicUrl === undefined
  )
    return saved;
  return {
    ...saved,
    ...(project.configuration?.repoUrl === undefined
      ? {}
      : { repositoryUrl: project.configuration.repoUrl }),
    ...(project.configuration?.publicUrl === undefined
      ? {}
      : { websiteUrl: project.configuration.publicUrl }),
  };
}
/**
 * Browser address for a git remote (`git@host:owner/repo.git`, `ssh://…`,
 * `https://…`). Credentials in the remote never reach the result.
 */
export function repositoryWebUrlFromGitRemote(remote: string): string | null {
  const value = remote
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "");
  let host: string;
  let path: string;
  const scp = /^[^@\s/]+@([^:/\s]+):([^\s]+)$/.exec(value);
  if (scp?.[1] && scp[2]) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const url = new URL(value);
      if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol)) return null;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (!host || segments.length < 2) return null;
  return `https://${host}/${segments.join("/")}`;
}
/**
 * Proposed repository address for a project with a folder but no repository:
 * the folder's `origin` remote as read by its computer (never written silently).
 */
export function projectRepositorySuggestion(project: GalleryProject): string | null {
  if (resolveGalleryProjectOverview(project).repositoryUrl) return null;
  const local = project.local;
  const identity = local?.repositoryIdentity;
  if (!local?.workspaceRoot || !identity || identity.locator.remoteName !== "origin") return null;
  return repositoryWebUrlFromGitRemote(identity.locator.remoteUrl);
}
/** The project whose name matches `title` (trimmed, case-insensitive), if any. */
export function findProjectWithSameName<Project extends { readonly title: string }>(
  projects: readonly Project[],
  title: string,
): Project | null {
  const name = title.trim().toLocaleLowerCase();
  if (name.length === 0) return null;
  return projects.find((project) => project.title.trim().toLocaleLowerCase() === name) ?? null;
}
/** Archiving keeps identity joins and histories intact; only the chosen gallery view changes. */
export function visibleGalleryProjects<Project extends GalleryProject>(
  projects: readonly Project[],
  archived: boolean = false,
): readonly Project[] {
  return projects.filter((project) => (project.local?.overview?.archived === true) === archived);
}
/** Open the exact history already joined by the gallery's persisted identity proof. */
export function resolveGalleryProjectHistory<Project extends GalleryLocalProject>(
  projects: readonly Project[],
  gallery: readonly GalleryProject[],
  nativeProjectId: string,
): Project | null {
  const local = gallery.find((project) => project.native && project.id === nativeProjectId)?.local;
  if (local == null) return null;
  return (
    projects.find(
      (project) => project.id === local.id && project.environmentId === local.environmentId,
    ) ?? null
  );
}
/** Join real local and native records by tenant and ID, including pending local intent. */
export function buildProjectGallery(input: {
  readonly projects: readonly GalleryLocalProject[];
  readonly nativeProjects: readonly CtoxWorkjetProjectProjection[];
  readonly instanceId: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly computers?: readonly WorkjetComputer[];
}): readonly GalleryProject[] {
  const bindings = resolveProjectHistoryBindings({
    instanceId: input.instanceId,
    nativeProjects: input.nativeProjects,
    projects: input.projects,
    computers: input.computers ?? [],
  });
  const bindingFor = (local: GalleryLocalProject) =>
    bindings.find(
      (binding) => binding.environmentId === local.environmentId && binding.projectId === local.id,
    );
  const eligible = input.projects.filter((project) =>
    input.instanceId === null
      ? project.ctoxRegistration == null
      : project.ctoxRegistration?.instanceId === input.instanceId ||
        bindingFor(project) !== undefined,
  );
  if (input.instanceId === null)
    return eligible.map((local) => ({
      key: `${local.environmentId}:${local.id}`,
      id: local.id,
      title: local.title,
      local,
      native: false,
    }));
  const native = input.nativeProjects.map((project) => {
    const candidates = eligible.filter(
      (local) => bindingFor(local)?.nativeProjectId === project.id,
    );
    const local =
      candidates.find(
        (candidate) =>
          candidate.id === project.id && candidate.environmentId === input.primaryEnvironmentId,
      ) ??
      candidates.find((candidate) => candidate.id === project.id) ??
      candidates.find((candidate) => candidate.environmentId === input.primaryEnvironmentId) ??
      candidates[0] ??
      null;
    return {
      key: `${input.instanceId}:${project.id}`,
      id: project.id,
      title: project.title,
      local,
      native: true,
      configuration: project,
    };
  });
  const ids = new Set(native.map((project) => project.id));
  const result: GalleryProject[] = [...native];
  for (const local of eligible) {
    if (bindingFor(local) !== undefined) continue;
    if (ids.has(local.id)) continue;
    ids.add(local.id);
    result.push({
      key: `${input.instanceId}:${local.id}`,
      id: local.id,
      title: local.title,
      local,
      native: false,
    });
  }
  return result;
}
