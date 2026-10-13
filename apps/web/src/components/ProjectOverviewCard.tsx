import { useEffect, useState, type ReactNode } from "react";
import { ProjectExitModelCardPanel, ProjectExitModelSummary } from "./ProjectExitModel";
import {
  ProjectCardConfigEditor,
  type ProjectCardConfigurationValues,
} from "./ProjectOverviewEditor";
import type { ProjectOverview } from "@workjet/contracts";
import { ArrowUpRightIcon, EllipsisIcon, ExternalLinkIcon, XIcon } from "lucide-react";
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
import { useProjectOverviewLanguage } from "../hooks/useProjectOverviewLanguage";
import { PROJECT_OVERVIEW_TEXT, projectOverviewFormat } from "../projectOverviewText";
import { Button } from "./ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { workjetUiLanguage } from "../workjetProjectControl";
import { useSingleInlineExpand } from "./ui/inline-expand";

export function ProjectOverviewCard({
  project,
  onOpen,
  onSave,
  onSaveConfiguration,
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
  /** Einstellungen › Projekt bleibt über diesen Pfad erreichbar (Fallback ohne Speicherpfad). */
  readonly onConfigure?: (() => void) | undefined;
  readonly onSave?: ((next: ProjectOverview) => Promise<boolean>) | undefined;
  /** Instanz-Pfad (project.configure) für Name, Website, Repository und Regeltermin. */
  readonly onSaveConfiguration?:
    | ((values: ProjectCardConfigurationValues) => Promise<boolean>)
    | undefined;
  readonly canArchive?: boolean | undefined;
  readonly statistics?: GalleryProjectStatistics | undefined;
}) {
  const en = workjetUiLanguage() === "en";
  const t = (de: string, english: string) => (en ? english : de);
  const [editing, setEditing] = useState<"exit" | "configure" | null>(null);
  const [failedCachedWebsite, setFailedCachedWebsite] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const text = PROJECT_OVERVIEW_TEXT[useProjectOverviewLanguage()];
  const openProjectLabel = projectOverviewFormat(text.cardOpenProjectLabel, {
    title: project.title,
  });
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
  const websiteHost =
    website
      ?.replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "") ?? null;
  const titleIsWebsite =
    websiteHost != null && project.title.trim().toLowerCase() === websiteHost.toLowerCase();
  const archived = overview.archived === true;
  // Die Rückseite ersetzt nur die Vorschaufläche; Spalte und Breite der Karte bleiben.
  const closeEditing = () => setEditing(null);
  // Only one card editor (Exit-Bewertung / Konfigurieren) is open across the
  // gallery: opening one closes every other InlineExpand, like the KPI tiles.
  useSingleInlineExpand(editing !== null, (open) => {
    if (!open) setEditing(null);
  });
  useEffect(() => {
    if (editing === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);
  const configuration = project.configuration ?? null;
  const saveCardConfiguration =
    (onSaveConfiguration ?? onSave)
      ? async (values: ProjectCardConfigurationValues): Promise<boolean> => {
          if (onSaveConfiguration) return onSaveConfiguration(values);
          if (!onSave) return false;
          return onSave({
            ...overview,
            websiteUrl: values.websiteUrl,
            ...(values.websiteUrl !== null ? {} : { websiteUrlCleared: true }),
            repositoryUrl: values.repositoryUrl,
            ...(overview.tokenBudget
              ? { tokenBudget: { ...overview.tokenBudget, jourFixe: values.jourFixe } }
              : {}),
          });
        }
      : undefined;
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
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2
            className="break-words text-[13.5px] leading-5 font-medium"
            title={project.title}
            data-workjet-project-title=""
          >
            {/* The title is the card's primary action: it opens the project in Workjet. */}
            <button
              type="button"
              onClick={onOpen}
              aria-label={openProjectLabel}
              data-workjet-action={`project.open.gallery-title:${project.key}`}
              className="text-left hover:text-primary focus-visible:outline focus-visible:outline-ring"
            >
              {project.title}
            </button>
          </h2>
          {website && !titleIsWebsite && (
            <p title={website} className="truncate text-xs text-muted-foreground">
              {websiteHost}
            </p>
          )}
        </div>
        {website && (
          <Button
            size="icon-xs"
            variant="ghost"
            render={<a href={website} target="_blank" rel="noreferrer noopener" />}
            title={text.cardOpenWebsite}
            aria-label={projectOverviewFormat(text.cardOpenWebsiteLabel, {
              title: project.title,
              url: website,
            })}
            data-workjet-action={`project.open.website:${project.key}`}
          >
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
          </Button>
        )}
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
                onClick={() => setEditing("exit")}
                data-workjet-action={`project.exit_model.menu:${project.key}`}
              >
                {t("Exit-Bewertung", "Exit valuation")}
              </MenuItem>
              {(saveCardConfiguration || onConfigure) && (
                <MenuItem
                  onClick={() =>
                    saveCardConfiguration ? setEditing("configure") : onConfigure?.()
                  }
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
      {editing !== null ? (
        <div
          className="relative aspect-video overflow-y-auto bg-muted/40"
          data-workjet-project-card-backface={editing}
          aria-label={
            editing === "exit"
              ? t(`Exit-Bewertung von ${project.title}`, `Exit valuation for ${project.title}`)
              : t(`${project.title} konfigurieren`, `Configure ${project.title}`)
          }
        >
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("Schließen", "Close")}
            onClick={closeEditing}
            data-workjet-action={`project.card.close:${project.key}`}
            className="absolute top-2 right-2 z-10"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </Button>
          {editing === "exit" ? (
            <ProjectExitModelCardPanel
              key={project.key}
              projectId={project.id}
              instanceId={project.native ? ctoxInstanceId : null}
              assessment={project.configuration?.exitModel ?? null}
            />
          ) : (
            saveCardConfiguration && (
              <ProjectCardConfigEditor
                key={project.key}
                title={configuration?.title ?? project.title}
                websiteUrl={configuration?.publicUrl ?? overview.websiteUrl}
                repositoryUrl={configuration?.repoUrl ?? overview.repositoryUrl ?? null}
                jourFixe={configuration?.jourFixe ?? overview.tokenBudget?.jourFixe ?? null}
                canEditTitle={onSaveConfiguration !== undefined}
                onSave={saveCardConfiguration}
                onCancel={closeEditing}
              />
            )
          )}
        </div>
      ) : (
        <div
          className="relative aspect-video overflow-hidden bg-muted/40"
          data-workjet-project-preview=""
        >
          {/* The whole preview opens the project; buttons on top keep their own actions. */}
          <button
            type="button"
            onClick={onOpen}
            aria-label={openProjectLabel}
            tabIndex={-1}
            data-workjet-action={`project.open.gallery-preview:${project.key}`}
            className="absolute inset-0 z-0 cursor-pointer"
          />
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
                  ? "pointer-events-none size-full object-contain p-12"
                  : "pointer-events-none size-full object-cover object-top"
              }
            />
          ) : (
            <div
              role="img"
              aria-label={t(`Logo von ${project.title}`, `${project.title} logo`)}
              className="pointer-events-none flex size-full items-center justify-center"
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
            title={text.cardOpenProject}
            aria-label={openProjectLabel}
            data-workjet-action={`project.open.gallery:${project.key}`}
            className="absolute right-2 bottom-2 gap-1.5 shadow-sm"
          >
            <ArrowUpRightIcon className="size-4" aria-hidden="true" />
          </Button>
          <ProjectExitModelSummary
            projectId={project.id}
            assessment={project.configuration?.exitModel ?? null}
          />
        </div>
      )}
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
      {archiveError && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {archiveError}
        </p>
      )}
    </article>
  );
}
