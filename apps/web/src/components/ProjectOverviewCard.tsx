import { useEffect, useState, type ReactNode } from "react";
import { ProjectExitModelCardPanel, ProjectExitModelSummary } from "./ProjectExitModel";
import { exitModelPresentation } from "../projectExitModel";
import { useLastKnownProjectCard } from "../projectCardCache";
import {
  ProjectCardConfigEditor,
  type ProjectCardConfigurationValues,
} from "./ProjectOverviewEditor";
import type { ProjectOverview } from "@workjet/contracts";
import { EllipsisIcon } from "lucide-react";
import { resolveCachedProjectPreview } from "../cachedProjectPreview";
import {
  type GalleryProject,
  projectUpdateAge,
  resolveGalleryProjectOverview,
  type GalleryProjectStatistics,
} from "../projectOverview";
import { suggestedProjectKpis } from "../projectKpiSuggestions";
import { type PromptedProjectKpis, type SaveProjectKpiPrompts } from "../projectKpis";
import { ProjectKpiTile } from "./ProjectKpiTile";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectInitProgress } from "./ProjectInitProgress";
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
  ctoxInstanceId = null,
  reorderHandle,
  tokenBudget,
  onSaveKpis,
  onRefreshKpis,
}: {
  /** Saves the card's KPI sentences inline (project.kpis.configure). */
  readonly onSaveKpis?: SaveProjectKpiPrompts | undefined;
  /** Recalculates the card's KPIs now (project.kpis.refresh, #502). */
  readonly onRefreshKpis?: (() => Promise<boolean>) | undefined;
  readonly project: GalleryProject;
  readonly tokenBudget?: ReactNode;
  readonly ctoxInstanceId?: string | null;
  readonly kpis?: PromptedProjectKpis | undefined;
  /**
   * The KPI read failed or timed out. The card shows the last known values (local
   * cache) or "—" either way, so this flag no longer changes what is rendered.
   */
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
  const [editingKpi, setEditingKpi] = useState<number | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
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
  // Drei Zustände je Kachel: unbekannt (`undefined`), leer, vorhanden. Unbekannt
  // zeigt den letzten bekannten Stand dieser Instanz, sonst „—“; nie einen Satz.
  const liveExitModel =
    project.configuration === undefined ? undefined : (project.configuration.exitModel ?? null);
  const known = useLastKnownProjectCard(project.native ? ctoxInstanceId : null, project.id, {
    kpis: project.native ? scopedKpis : undefined,
    exitModel: project.native ? liveExitModel : undefined,
  });
  const knownKpis = known.kpis?.project_id === project.id ? known.kpis : undefined;
  const exitModel = known.exitModel;
  const websiteHost =
    website
      ?.replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "") ?? null;
  const titleIsWebsite =
    websiteHost != null && project.title.trim().toLowerCase() === websiteHost.toLowerCase();
  const archived = overview.archived === true;
  const hasPreview = !archived && cachedPreview != null && failedCachedWebsite !== website;
  const exitValued = exitModelPresentation(exitModel ?? null, project.id).value !== "—";
  // „Bewerten“ nur mit Startweg (Rückseite → project.exit_model.refresh) und nur bei
  // einem gelesenen Stand ohne Wert; bei unbekanntem Stand steht nichts.
  const canRate =
    project.native &&
    !archived &&
    ctoxInstanceId !== null &&
    exitModel !== undefined &&
    !exitValued &&
    exitModel?.status !== "researching";
  const kpisEmpty = project.native && knownKpis !== undefined && knownKpis.items.length === 0;
  // Die Rückseite ersetzt nur die Vorschaufläche; Spalte und Breite der Karte bleiben.
  const refreshKpis = async () => {
    if (!onRefreshKpis || refreshPending) return;
    setRefreshPending(true);
    setArchiveError(null);
    const ok = await onRefreshKpis();
    setRefreshPending(false);
    if (!ok) setArchiveError(t("Neuberechnung nicht erreichbar.", "Recalculation not reachable."));
  };
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
  const configureCard =
    archived || (!saveCardConfiguration && !onConfigure)
      ? undefined
      : () => (saveCardConfiguration ? setEditing("configure") : onConfigure?.());
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
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
      data-workjet-project-card={project.key}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        {/* Lokale Projekte tragen ihr Favicon im Kopf statt einer Vorschaufläche. */}
        {!hasPreview && project.local?.workspaceRoot ? (
          <ProjectFavicon
            environmentId={project.local.environmentId}
            cwd={project.local.workspaceRoot}
            faviconPath={project.local.faviconPath}
            className="size-5 shrink-0"
          />
        ) : null}
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
          {/* The website is a visible domain link, not an icon explained by a tooltip (#577). */}
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={projectOverviewFormat(text.cardOpenWebsiteLabel, {
                title: project.title,
                url: website,
              })}
              data-workjet-action={`project.open.website:${project.key}`}
              className="block truncate text-xs text-muted-foreground hover:text-foreground"
            >
              {titleIsWebsite
                ? website.replace(/^https?:\/\//, "").replace(/\/$/, "")
                : websiteHost}
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
              {onRefreshKpis && scopedKpis && scopedKpis.items.length > 0 && (
                <MenuItem
                  disabled={refreshPending}
                  onClick={() => void refreshKpis()}
                  data-workjet-action={`project.kpis.refresh.menu:${project.key}`}
                >
                  {refreshPending
                    ? t("Wird berechnet …", "Calculating …")
                    : t("KPIs neu berechnen", "Recalculate KPIs")}
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
            size="xs"
            variant="ghost"
            onClick={closeEditing}
            data-workjet-action={`project.card.close:${project.key}`}
            className="absolute top-2 right-2 z-10"
          >
            {t("Fertig", "Done")}
          </Button>
          {editing === "exit" ? (
            <ProjectExitModelCardPanel
              key={project.key}
              projectId={project.id}
              instanceId={project.native ? ctoxInstanceId : null}
              assessment={exitModel ?? null}
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
      ) : hasPreview && cachedPreview ? (
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
          <ProjectExitModelSummary
            projectId={project.id}
            assessment={exitModel ?? null}
            onEdit={archived ? undefined : () => setEditing("exit")}
            editLabel={t("Exit-Bewertung bearbeiten", "Edit exit valuation")}
          />
          {canRate && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing("exit")}
              className="absolute bottom-2 left-2 z-10"
              data-workjet-action={`project.exit_model.rate:${project.key}`}
            >
              {t("Bewerten", "Rate")}
            </Button>
          )}
        </div>
      ) : exitValued ? (
        // Ohne Vorschaubild keine leere Fläche: nur der Wertstempel bekommt Platz.
        <div className="relative h-20" data-workjet-project-stamp-row="">
          <ProjectExitModelSummary
            projectId={project.id}
            assessment={exitModel ?? null}
            onEdit={archived ? undefined : () => setEditing("exit")}
            editLabel={t("Exit-Bewertung bearbeiten", "Edit exit valuation")}
          />
        </div>
      ) : canRate ? (
        <div className="px-3 pb-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing("exit")}
            data-workjet-action={`project.exit_model.rate:${project.key}`}
          >
            {t("Bewerten", "Rate")}
          </Button>
        </div>
      ) : null}
      {project.native ? (
        <ProjectInitProgress
          instanceId={ctoxInstanceId}
          projectId={project.id}
          kpiCount={scopedKpis?.items.length ?? 0}
          exitStatus={project.configuration?.exitModel?.status ?? null}
        />
      ) : null}
      {/* mt-auto: the KPI strip sits at the card's foot, so cards of one row stay
          flush (head, KPI strip, actions) with or without a preview image. */}
      <div className="relative mt-auto border-t border-border px-3 py-3">
        {/* Tapping the KPI strip edits the card inline; the menu keeps only rare actions (#561). */}
        {configureCard && !(project.native && knownKpis) && (
          <button
            type="button"
            onClick={configureCard}
            aria-label={t(`${project.title} konfigurieren`, `Configure ${project.title}`)}
            data-workjet-action={`project.configure.gallery:${project.key}`}
            className="absolute inset-0 z-0 cursor-pointer hover:bg-accent/40"
          />
        )}
        {kpisEmpty && onSaveKpis && editingKpi === null ? (
          <div className="flex h-12 items-center" data-workjet-project-card-slots="">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => setEditingKpi(0)}
              data-workjet-action={`project.kpis.define:${project.key}`}
            >
              {t("Kennzahlen festlegen", "Define metrics")}
            </Button>
          </div>
        ) : (
          <dl
            className={
              configureCard && !(project.native && knownKpis)
                ? "pointer-events-none relative grid min-w-0 grid-cols-3 gap-2 [&_a]:pointer-events-auto"
                : "relative grid min-w-0 grid-cols-3 gap-2"
            }
            data-workjet-project-card-slots=""
          >
            {(["first", "second", "third"] as const).map((position, index) => {
              if (project.native && knownKpis) {
                // Leer und gerade im Editor: nur die erste Kachel, aufgeklappt.
                if (kpisEmpty && index > 0) return null;
                return (
                  <ProjectKpiTile
                    key={position}
                    projectId={project.id}
                    index={index}
                    kpis={knownKpis}
                    expanded={editingKpi === index}
                    onExpandedChange={(open) => setEditingKpi(open ? index : null)}
                    onSave={onSaveKpis}
                    onRefresh={onRefreshKpis}
                  />
                );
              }
              // Native KPIs unbekannt (nie gelesen oder Lesen gescheitert, kein
              // gespeicherter Stand): ein selbst gesetzter Wert der Kachel bleibt,
              // sonst „—“ ohne Unterzeile in gleicher Zeilenhöhe.
              if (project.native && !overview.slots[index])
                return (
                  <div
                    key={position}
                    className="flex h-12 min-w-0 flex-col gap-0.5"
                    data-workjet-project-card-slot={index + 1}
                    data-workjet-kpi-unknown=""
                  >
                    <dt className="sr-only">{`KPI ${index + 1}`}</dt>
                    <dd className="text-[22px] leading-7 font-semibold tracking-tight text-muted-foreground">
                      —
                    </dd>
                  </div>
                );
              const slot = slots[index] ?? null;
              return (
                <div
                  key={position}
                  className="flex min-h-12 min-w-0 flex-col gap-0.5"
                  data-workjet-project-card-slot={index + 1}
                >
                  <dt
                    title={slot?.label}
                    className={
                      slot
                        ? "min-w-0 break-words text-[11px] leading-4 text-muted-foreground"
                        : "sr-only"
                    }
                  >
                    {slot?.label ?? `KPI ${index + 1}`}
                  </dt>
                  <dd className="order-first min-w-0 break-words text-[22px] leading-7 font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]">
                    {slot === null ? (
                      <span className="text-muted-foreground">—</span>
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
        )}
      </div>
      {archiveError && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {archiveError}
        </p>
      )}
    </article>
  );
}
