import { useState, type ReactNode } from "react";
import { ProjectExitModelPanel, ProjectExitModelSummary } from "./ProjectExitModel";
import type { ProjectOverview } from "@workjet/contracts";
import { ArrowUpRightIcon, EllipsisIcon, XIcon } from "lucide-react";
import { resolveCachedProjectPreview } from "../cachedProjectPreview";
import {
  type GalleryProject,
  projectUpdateAge,
  resolveGalleryProjectOverview,
  type GalleryProjectStatistics,
} from "../projectOverview";
import { suggestedProjectKpis } from "../projectKpiSuggestions";
import { projectKpiPresentation, type PromptedProjectKpis } from "../projectKpis";
import { ProjectFavicon } from "./ProjectFavicon";
import { Button } from "./ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { workjetUiLanguage } from "../workjetProjectControl";

export function ProjectOverviewCard({
  project,
  onOpen,
  onSave,
  canArchive = false,
  statistics,
  onConfigure,
  kpis,
  kpisUnavailable = false,
  ctoxInstanceId = null,
  reorderHandle,
  tokenBudget,
}: {
  readonly project: GalleryProject;
  readonly tokenBudget?: ReactNode;
  readonly ctoxInstanceId?: string | null;
  readonly kpis?: PromptedProjectKpis | undefined;
  /** The KPI read failed or timed out; show the fallback slots instead of a skeleton. */
  readonly kpisUnavailable?: boolean | undefined;
  readonly reorderHandle?: ReactNode;
  readonly onOpen: () => void;
  /** Projekt-Einstellungen leben unter Einstellungen › Projekte (Ort C). */
  readonly onConfigure?: (() => void) | undefined;
  readonly onSave?: ((next: ProjectOverview) => Promise<boolean>) | undefined;
  readonly canArchive?: boolean | undefined;
  readonly statistics?: GalleryProjectStatistics | undefined;
}) {
  const en = workjetUiLanguage() === "en";
  const t = (de: string, english: string) => (en ? english : de);
  const [assessing, setAssessing] = useState(false);
  const [failedCachedWebsite, setFailedCachedWebsite] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const overview = resolveGalleryProjectOverview(project);
  const website = overview.websiteUrl;
  const cachedPreview = resolveCachedProjectPreview(website);
  const repository = overview.repositoryUrl;
  const suggestedSlots = suggestedProjectKpis(project.title);
  const defaultSlots: ProjectOverview["slots"] = suggestedSlots ?? [
    {
      kind: "text",
      label: "Chats",
      value: statistics?.chatCount == null ? "—" : String(statistics.chatCount),
    },
    {
      kind: "text",
      label: t("Aktiv", "Active"),
      value: statistics?.activeChatCount == null ? "—" : String(statistics.activeChatCount),
    },
    { kind: "updated", label: t("Aktivität", "Activity") },
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
  // Der Exit öffnet inline in der Karte; das Raster lässt die Karte die Zeile füllen.
  const expanded = assessing;
  const changeArchive = async () => {
    if (!onSave || archivePending) return false;
    setArchivePending(true);
    setArchiveError(null);
    try {
      if (!(await onSave({ ...overview, archived: !archived })))
        throw new Error("project not saved");
      return true;
    } catch {
      setArchiveError(t("Projekt nicht gespeichert.", "Project not saved."));
      return false;
    } finally {
      setArchivePending(false);
    }
  };
  return (
    <article
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
      data-workjet-project-card={project.key}
      data-workjet-project-card-expanded={expanded ? "" : undefined}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2
            className="break-words text-[13.5px] leading-5 font-medium"
            title={project.title}
            data-workjet-project-title=""
          >
            {titleIsWebsite ? (
              <a
                href={website ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
                className="hover:text-primary focus-visible:outline focus-visible:outline-ring"
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
              className="block truncate text-xs text-muted-foreground hover:text-primary focus-visible:outline focus-visible:outline-ring"
            >
              {website}
            </a>
          )}
        </div>
        {tokenBudget}
        {reorderHandle}
        {
          <Menu>
            <MenuTrigger
              aria-label={t(`Aktionen für ${project.title}`, `Actions for ${project.title}`)}
              render={<Button size="icon-xs" variant="ghost" />}
            >
              <EllipsisIcon className="size-4" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() => setAssessing(true)}
                data-workjet-action={`project.exit_model.menu:${project.key}`}
              >
                {t("Exit-Bewertung", "Exit valuation")}
              </MenuItem>
              {onConfigure && (
                <MenuItem
                  onClick={onConfigure}
                  aria-label={t(`${project.title} konfigurieren`, `Configure ${project.title}`)}
                  data-workjet-action={`project.configure.gallery:${project.key}`}
                >
                  {t("Projekt konfigurieren", "Configure project")}
                </MenuItem>
              )}
              {repository && (
                <MenuItem
                  render={<a href={repository} target="_blank" rel="noreferrer noopener" />}
                >
                  {t("Repository öffnen", "Open repository")}
                </MenuItem>
              )}
              {onSave && canArchive && (
                <MenuItem
                  disabled={archivePending}
                  onClick={() => void changeArchive()}
                  aria-label={
                    archived
                      ? t(`${project.title} wiederherstellen`, `Restore ${project.title}`)
                      : t(`${project.title} archivieren`, `Archive ${project.title}`)
                  }
                >
                  {archivePending
                    ? t("Speichern …", "Saving …")
                    : archived
                      ? t("Projekt wiederherstellen", "Restore project")
                      : t("Projekt archivieren", "Archive project")}
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        }
      </div>
      {!expanded && (
        <>
          <div
            className="relative aspect-video overflow-hidden bg-muted/40"
            data-workjet-project-preview=""
          >
            {!archived && cachedPreview && failedCachedWebsite !== website ? (
              <img
                src={cachedPreview.image}
                alt={
                  cachedPreview.kind === "logo"
                    ? t(`Logo von ${project.title}`, `${project.title} logo`)
                    : t(
                        `Gespeicherte Vorschau von ${project.title}`,
                        `Saved preview of ${project.title}`,
                      )
                }
                title={`${t("Gespeicherte Vorschau", "Saved preview")} · ${cachedPreview.capturedOn}`}
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
                aria-label={t(`Logo von ${project.title}`, `${project.title} logo`)}
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
                  <span className="flex size-16 items-center justify-center rounded-2xl bg-background/80 text-[22px] font-semibold tracking-tight text-foreground/70">
                    {project.title.slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
            )}
            <Button
              size="icon-sm"
              onClick={onOpen}
              title={t("Projekt öffnen", "Open project")}
              aria-label={t(`${project.title} öffnen`, `Open ${project.title}`)}
              data-workjet-action={`project.open.gallery:${project.key}`}
              className="absolute right-2 bottom-2 gap-1.5 shadow-sm"
            >
              <ArrowUpRightIcon className="size-4" aria-hidden="true" />
            </Button>
            <ProjectExitModelSummary
              projectId={project.id}
              assessment={project.configuration?.exitModel ?? null}
              onOpen={() => setAssessing(true)}
            />
          </div>
          <div className="border-t border-border px-3 py-3">
            <dl className="grid min-w-0 grid-cols-3 gap-2" data-workjet-project-card-slots="">
              {(["first", "second", "third"] as const).map((position, index) => {
                const slot = slots[index] ?? null;
                const metric = scopedKpis
                  ? projectKpiPresentation(scopedKpis.items[index], project.id, index + 1)
                  : null;
                // Native KPIs still loading, or configured but without a resolved label yet:
                // show a skeleton instead of a placeholder that flips to the real name (#470).
                if (
                  project.native &&
                  kpis === undefined &&
                  !kpisUnavailable &&
                  !overview.slots[index] &&
                  !suggestedSlots
                )
                  return (
                    <div
                      key={position}
                      className="flex min-w-0 flex-col gap-1"
                      data-workjet-project-card-slot={index + 1}
                      data-workjet-kpi-loading=""
                      aria-busy="true"
                    >
                      <span className="h-7 w-14 animate-pulse rounded bg-muted" />
                      <span className="h-3 w-20 animate-pulse rounded bg-muted" />
                    </div>
                  );
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
                    <dd className="order-first min-w-0 break-words text-[22px] leading-7 font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]">
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
                          aria-label={t(
                            `KPI ${index + 1} nicht eingerichtet`,
                            `KPI ${index + 1} not set up`,
                          )}
                        >
                          —
                        </span>
                      ) : slot.kind === "link" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          render={<a href={slot.url} target="_blank" rel="noreferrer noopener" />}
                        >
                          {t("Link öffnen", "Open link")}
                        </Button>
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
        </>
      )}
      {archiveError && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {archiveError}
        </p>
      )}
      {assessing && (
        <section
          aria-label={`${t("Exit in fünf Jahren", "Exit in five years")} · ${project.title}`}
          className="border-t border-border px-3 py-3"
          data-workjet-project-card-section="exit"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[13.5px] font-medium">
              {t("Exit in fünf Jahren", "Exit in five years")}
            </h3>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("Schließen", "Close")}
              onClick={() => setAssessing(false)}
            >
              <XIcon className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <ProjectExitModelPanel
            key={project.key}
            projectId={project.id}
            instanceId={project.native ? ctoxInstanceId : null}
            assessment={project.configuration?.exitModel ?? null}
          />
        </section>
      )}
    </article>
  );
}
