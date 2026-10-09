import { useEffect, useState, type ReactNode } from "react";
import type { ProjectOverview } from "@workjet/contracts";
import { ArrowUpRightIcon, EllipsisIcon } from "lucide-react";
import { resolveCachedProjectPreview } from "../cachedProjectPreview";
import {
  type GalleryProject,
  projectUpdateAge,
  resolveGalleryProjectOverview,
  type GalleryProjectStatistics,
} from "../projectOverview";
import { suggestedProjectKpis } from "../projectKpiSuggestions";
import {
  projectKpiPresentation,
  type PromptedProjectKpis,
  type SaveProjectKpiPrompts,
} from "../projectKpis";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectOverviewEditor, type ProjectConfigurationValues } from "./ProjectOverviewEditor";
import { Button } from "./ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "./ui/dialog";

export function ProjectOverviewCard({
  project,
  onOpen,
  onSave,
  canArchive = false,
  statistics,
  onSaveConfiguration,
  kpis,
  onSaveKpis,
  onReadKpis,
  reorderHandle,
}: {
  readonly project: GalleryProject;
  readonly kpis?: PromptedProjectKpis | undefined;
  readonly onSaveKpis?: SaveProjectKpiPrompts | undefined;
  readonly onReadKpis?: ((projectId: string) => Promise<PromptedProjectKpis | null>) | undefined;
  readonly reorderHandle?: ReactNode;
  readonly onOpen: () => void;
  readonly onSaveConfiguration?:
    | ((next: ProjectConfigurationValues) => Promise<boolean>)
    | undefined;
  readonly onSave?: ((next: ProjectOverview) => Promise<boolean>) | undefined;
  readonly canArchive?: boolean | undefined;
  readonly statistics?: GalleryProjectStatistics | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [kpiReadAttempt, setKpiReadAttempt] = useState(0);
  const [kpiReadStatus, setKpiReadStatus] = useState<"idle" | "pending" | "ready" | "failed">("idle");
  useEffect(() => {
    if (!editing || !onReadKpis) return;
    let active = true;
    setKpiReadStatus("pending");
    void onReadKpis(project.id)
      .then((result) => {
        if (active) setKpiReadStatus(result === null ? "failed" : "ready");
      })
      .catch(() => {
        if (active) setKpiReadStatus("failed");
      });
    return () => {
      active = false;
    };
  }, [editing, onReadKpis, project.id, kpiReadAttempt]);
  const [failedCachedWebsite, setFailedCachedWebsite] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const overview = resolveGalleryProjectOverview(project);
  const website = overview.websiteUrl;
  const cachedPreview = resolveCachedProjectPreview(website);
  const repository = overview.repositoryUrl;
  const defaultSlots: ProjectOverview["slots"] = suggestedProjectKpis(project.title) ?? [
    {
      kind: "text",
      label: "Chats",
      value: statistics?.chatCount == null ? "—" : String(statistics.chatCount),
    },
    {
      kind: "text",
      label: "Active",
      value: statistics?.activeChatCount == null ? "—" : String(statistics.activeChatCount),
    },
    { kind: "updated", label: "Activity" },
  ];
  const activityAt = statistics?.lastActivityAt ?? project.local?.updatedAt ?? null;
  const slots: ProjectOverview["slots"] = [
    overview.slots[0] ?? defaultSlots[0],
    overview.slots[1] ?? defaultSlots[1],
    overview.slots[2] ?? defaultSlots[2],
  ];
  const scopedKpis = kpis?.project_id === project.id ? kpis : undefined;
  const titleIsWebsite =
    website != null &&
    project.title.trim().toLowerCase() ===
      website
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "")
        .toLowerCase();
  const archived = overview.archived === true;
  const changeArchive = async () => {
    if (!onSave || archivePending) return false;
    setArchivePending(true);
    setArchiveError(null);
    try {
      if (!(await onSave({ ...overview, archived: !archived })))
        throw new Error("The project could not be saved. Try again.");
      setEditing(false);
      return true;
    } catch {
      setArchiveError("The project could not be saved. Try again.");
      return false;
    } finally {
      setArchivePending(false);
    }
  };
  return (
    <article
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
      data-workjet-project-card={project.key}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2
            className="break-words text-sm leading-5 font-medium"
            title={project.title}
            data-workjet-project-title=""
          >
            {titleIsWebsite ? (
              <a
                href={website ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
                className="hover:underline focus-visible:outline focus-visible:outline-ring"
              >
                {project.title}
              </a>
            ) : (
              project.title
            )}
          </h2>
          {website && !titleIsWebsite && (
            <a
              href={website}
              target="_blank"
              rel="noreferrer noopener"
              title={website}
              className="block truncate text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline focus-visible:outline-ring"
            >
              {website}
            </a>
          )}
        </div>
        {reorderHandle}
        {(repository || onSave) && (
          <Menu>
            <MenuTrigger
              aria-label={`Project actions for ${project.title}`}
              render={<Button size="icon-xs" variant="ghost" />}
            >
              <EllipsisIcon className="size-4" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              {onSave && (
                <MenuItem
                  onClick={() => setEditing(true)}
                  aria-label={`Configure ${project.title}`}
                >
                  Configure project
                </MenuItem>
              )}
              {repository && (
                <MenuItem
                  render={<a href={repository} target="_blank" rel="noreferrer noopener" />}
                >
                  Open repository
                </MenuItem>
              )}
              {onSave && canArchive && (
                <MenuItem
                  disabled={archivePending}
                  onClick={() => void changeArchive()}
                  aria-label={`${archived ? "Restore" : "Archive"} ${project.title}`}
                >
                  {archivePending ? "Saving…" : archived ? "Restore project" : "Archive project"}
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        )}
      </div>
      <div
        className="relative aspect-video overflow-hidden bg-muted/40"
        data-workjet-project-preview=""
      >
        {!archived && cachedPreview && failedCachedWebsite !== website ? (
          <img
            src={cachedPreview.image}
            alt={
              cachedPreview.kind === "logo"
                ? `Project logo for ${project.title}`
                : `Saved website preview for ${project.title}`
            }
            title={`Saved preview · ${cachedPreview.capturedOn}`}
            loading="lazy"
            decoding="async"
            onError={() => setFailedCachedWebsite(website ?? null)}
            className={
              cachedPreview.kind === "logo"
                ? "size-full object-contain p-12"
                : "size-full object-cover object-top"
            }
          />
        ) : (
          <div
            role="img"
            aria-label={`Project logo for ${project.title}`}
            className="flex size-full items-center justify-center"
            data-workjet-project-logo=""
          >
            {project.local?.workspaceRoot ? (
              <ProjectFavicon
                environmentId={project.local.environmentId}
                cwd={project.local.workspaceRoot}
                faviconPath={project.local.faviconPath}
                className="size-16"
              />
            ) : (
              <span className="flex size-16 items-center justify-center rounded-2xl bg-background/80 text-2xl font-semibold tracking-tight text-foreground/70">
                {project.title.slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>
        )}
        <Button
          size="icon-sm"
          onClick={onOpen}
          title="Open project"
          aria-label={`Open ${project.title}`}
          data-workjet-action={`project.open.gallery:${project.key}`}
          className="absolute right-2 bottom-2 gap-1.5 shadow-sm"
        >
          <ArrowUpRightIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="border-t border-border px-3 py-3">
        <dl className="grid min-w-0 grid-cols-3 gap-2" data-workjet-project-card-slots="">
          {(["first", "second", "third"] as const).map((position, index) => {
            const slot = slots[index] ?? null;
            const metric = scopedKpis
              ? projectKpiPresentation(scopedKpis.items[index], project.id, index + 1)
              : null;
            return (
              <div
                key={position}
                className="flex min-w-0 flex-col gap-0.5"
                data-workjet-project-card-slot={index + 1}
              >
                <dt
                  title={metric?.label ?? slot?.label}
                  className={
                    slot
                      ? "min-w-0 break-words text-[11px] leading-4 text-muted-foreground"
                      : "sr-only"
                  }
                >
                  {metric?.label ?? slot?.label ?? `KPI ${index + 1}`}
                </dt>
                <dd className="order-first min-w-0 break-words text-lg leading-6 font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]">
                  {metric ? (
                    <span
                      title={metric.message ?? metric.detail}
                      data-workjet-kpi-status={metric.status}
                    >
                      {metric.value}
                    </span>
                  ) : slot === null ? (
                    <span
                      className="text-muted-foreground"
                      aria-label={`KPI ${index + 1} not configured`}
                    >
                      —
                    </span>
                  ) : slot.kind === "link" ? (
                    <a
                      href={slot.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-primary underline"
                    >
                      Open link
                    </a>
                  ) : slot.kind === "updated" ? (
                    <time dateTime={activityAt ?? undefined} title={activityAt ?? undefined}>
                      {activityAt === null ? "—" : projectUpdateAge(activityAt)}
                    </time>
                  ) : slot.kind === "metric" ? (
                    `${slot.value}${slot.unit ? ` ${slot.unit}` : ""}`
                  ) : (
                    slot.value
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      {archiveError && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {archiveError}
        </p>
      )}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogPopup className="w-[min(44rem,calc(100vw-2rem))] max-w-none">
          <DialogHeader>
            <DialogTitle>Manage {project.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {kpiReadStatus === "pending" && (
              <p role="status" className="mb-3 text-xs text-muted-foreground">Loading KPI prompts…</p>
            )}
            {kpiReadStatus === "failed" && (
              <div className="mb-3 flex items-center justify-between gap-3">
                <p role="alert" className="text-xs text-destructive">Couldn’t load KPI prompts.</p>
                <Button size="sm" variant="outline" onClick={() => setKpiReadAttempt((attempt) => attempt + 1)}>
                  Retry
                </Button>
              </div>
            )}
            {editing && onSave && (
              <ProjectOverviewEditor
                overview={overview}
                configuration={project.configuration}
                onSaveConfiguration={onSaveConfiguration}
                onSave={onSave}
                onCancel={() => setEditing(false)}
                kpis={scopedKpis}
                onSaveKpis={onSaveKpis}
                onArchive={canArchive ? changeArchive : undefined}
                archived={archived}
              />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </article>
  );
}
