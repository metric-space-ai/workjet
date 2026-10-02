import {
  ProjectOverview,
  type CtoxWorkjetProjectProjection,
  type EnvironmentId,
  type OrchestrationProjectShell,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

export type OverviewSlotDraft = {
  kind: "empty" | "text" | "link" | "updated" | "metric";
  label: string;
  value: string;
  unit: string;
};
export type OverviewDraft = {
  websiteUrl: string;
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
  return { websiteUrl: overview?.websiteUrl ?? "", slots: [draft(0), draft(1), draft(2)] };
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
  return decodeOverview({
    websiteUrl: draft.websiteUrl.trim() || null,
    slots: draft.slots.map(slot),
  });
}
export function projectUpdateAge(updatedAt: string | null, now: number = Date.now()): string {
  if (updatedAt === null || !Number.isFinite(Date.parse(updatedAt))) return "Not available";
  const minutes = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
export type GalleryLocalProject = Pick<
  OrchestrationProjectShell,
  "id" | "title" | "updatedAt" | "overview" | "ctoxRegistration"
> & { readonly environmentId: EnvironmentId };
export type GalleryProject = {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly local: GalleryLocalProject | null;
  readonly native: boolean;
};
/** Join real local and native records by tenant and ID, including pending local intent. */
export function buildProjectGallery(input: {
  readonly projects: readonly GalleryLocalProject[];
  readonly nativeProjects: readonly CtoxWorkjetProjectProjection[];
  readonly instanceId: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): readonly GalleryProject[] {
  const eligible = input.projects.filter((project) =>
    input.instanceId === null
      ? project.ctoxRegistration == null
      : project.ctoxRegistration?.instanceId === input.instanceId,
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
    const candidates = eligible.filter((local) => local.id === project.id);
    const local =
      candidates.find((candidate) => candidate.environmentId === input.primaryEnvironmentId) ??
      candidates[0] ??
      null;
    return {
      key: `${input.instanceId}:${project.id}`,
      id: project.id,
      title: local?.title ?? project.title,
      local,
      native: true,
    };
  });
  const ids = new Set(native.map((project) => project.id));
  const result: GalleryProject[] = [...native];
  for (const local of eligible) {
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
