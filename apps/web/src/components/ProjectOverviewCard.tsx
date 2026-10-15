import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import { ProjectExitModelCardPanel, ProjectExitModelSummary } from "./ProjectExitModel";
import { exitModelPresentation } from "../projectExitModel";
import { useLastKnownProjectCard } from "../projectCardCache";
import {
  ProjectCardConfigEditor,
  type ProjectCardConfigurationValues,
} from "./ProjectOverviewEditor";
import type { ProjectOverview } from "@workjet/contracts";
import { CalendarClockIcon, EllipsisIcon, UserRoundIcon } from "lucide-react";
import {
  resolveProjectPreview,
  type ProjectPreviewRepositoryIdentity,
} from "../cachedProjectPreview";
import {
  type GalleryProject,
  projectUpdateAge,
  resolveGalleryProjectOverview,
  type GalleryProjectStatistics,
} from "../projectOverview";
import { suggestedProjectKpis } from "../projectKpiSuggestions";
import {
  isRunningProjectOneShot,
  projectOverviewStatusTone,
  projectOverviewWorkerState,
} from "../projectOverviewModel";
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

/** Lumas of a project on its card: who is on the team now, and how many are disrupted. */
export type ProjectCardCrew = { readonly lumas: number; readonly disrupted: number };

/**
 * Team state for the card's content area, from the project's own histories: the
 * supervisor and fixed Lumas always count, one-time Lumas while they work or are disrupted.
 * `null` without a local project (unknown, the card shows „—“).
 */
export function projectCardCrew(
  local: GalleryProject["local"],
  threads: readonly EnvironmentThreadShell[],
): ProjectCardCrew | null {
  if (local === null) return null;
  const disrupted = (thread: EnvironmentThreadShell) =>
    projectOverviewStatusTone(projectOverviewWorkerState(thread)) === "red";
  const team = threads.filter(
    (thread) =>
      thread.environmentId === local.environmentId &&
      thread.projectId === local.id &&
      thread.archivedAt === null &&
      thread.deletedAt == null &&
      (isRunningProjectOneShot(thread) || disrupted(thread)),
  );
  return { lumas: team.length, disrupted: team.filter(disrupted).length };
}

const JOUR_FIXE_WEEKDAYS = {
  de: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
} as const;

/** „Di · 10:00“: weekday and time of the weekly Regeltermin, else „—“. */
export function projectCardJourFixeLabel(
  jourFixe: { readonly weekday: number; readonly time: string } | null | undefined,
  language: "de" | "en",
): string {
  const weekday = jourFixe ? JOUR_FIXE_WEEKDAYS[language][jourFixe.weekday - 1] : undefined;
  return jourFixe && weekday ? `${weekday} · ${jourFixe.time}` : "—";
}

/**
 * Elements inside the card that keep their own action: a click there never opens the
 * project (menu, „Bewerten“, „Kennzahlen festlegen“, KPI editor, drag handle, links).
 */
const CARD_OWN_ACTION_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "label",
  "[role='menu']",
  "[role='menuitem']",
  "[data-workjet-project-card-backface]",
  "[data-workjet-kpi-tile-expanded]",
].join(",");
/** A pointer that moved further than this between press and release dragged, not clicked. */
const CARD_CLICK_SLOP_PX = 6;

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
  crew,
}: {
  /** Team state shown when the card has no preview (`null`/missing: unknown). */
  readonly crew?: ProjectCardCrew | null | undefined;
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
  const [failedPreviewImage, setFailedPreviewImage] = useState<string | null>(null);
  const pressedAt = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [editingKpi, setEditingKpi] = useState<number | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const text = PROJECT_OVERVIEW_TEXT[useProjectOverviewLanguage()];
  const openProjectLabel = projectOverviewFormat(text.cardOpenProjectLabel, {
    title: project.title,
  });
  const overview = resolveGalleryProjectOverview(project);
  const configuration = project.configuration ?? null;
  const website = overview.websiteUrl;
  const repository = overview.repositoryUrl;
  // Website snapshot first, else the repository's GitHub social preview (WP-K2).
  const localRepository = (
    project.local as { readonly repositoryIdentity?: ProjectPreviewRepositoryIdentity | null } | null
  )?.repositoryIdentity;
  const preview = resolveProjectPreview({
    websiteUrl: website,
    repositoryUrl: repository,
    repositoryIdentity: localRepository,
  });
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
  const shownPreview =
    !archived && preview !== null && failedPreviewImage !== preview.image ? preview : null;
  const hasPreview = shownPreview !== null;
  const jourFixe = configuration?.jourFixe ?? overview.tokenBudget?.jourFixe ?? null;
  const jourFixeLabel = projectCardJourFixeLabel(jourFixe, en ? "en" : "de");
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
  // The whole card opens the project; its own controls keep their actions, a drag
  // (pointer moved) or a click inside an open editor never opens it.
  const openFromCard = (event: ReactMouseEvent<HTMLElement>) => {
    const pressed = pressedAt.current;
    pressedAt.current = null;
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    if (target.closest(CARD_OWN_ACTION_SELECTOR)) return;
    if (
      pressed !== null &&
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CARD_CLICK_SLOP_PX
    )
      return;
    onOpen();
  };
  const rememberPress = (event: ReactPointerEvent<HTMLElement>) => {
    pressedAt.current = { x: event.clientX, y: event.clientY };
  };
  const openFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };
  return (
    <article
      className="flex h-full min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      data-workjet-project-card={project.key}
      tabIndex={0}
      aria-label={openProjectLabel}
      onPointerDown={rememberPress}
      onClick={openFromCard}
      onKeyDown={openFromKeyboard}
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
              {configureCard && (
                <MenuItem
                  onClick={configureCard}
                  data-workjet-action={`project.configure.gallery:${project.key}`}
                >
                  {t("Konfigurieren", "Configure")}
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
      ) : shownPreview ? (
        <div
          className="relative aspect-video overflow-hidden bg-muted/40"
          data-workjet-project-preview={shownPreview.kind}
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
            src={shownPreview.image}
            alt={
              shownPreview.kind === "logo"
                ? t(`Logo von ${project.title}`, `${project.title} logo`)
                : shownPreview.kind === "github"
                  ? t(`GitHub-Vorschau von ${project.title}`, `GitHub preview of ${project.title}`)
                  : t(
                      `Gespeicherte Vorschau von ${project.title}`,
                      `Saved preview of ${project.title}`,
                    )
            }
            title={
              shownPreview.capturedOn === null
                ? undefined
                : `${t("Gespeicherte Vorschau", "Saved preview")} · ${shownPreview.capturedOn}`
            }
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedPreviewImage(shownPreview.image)}
            className={
              shownPreview.kind === "logo"
                ? "pointer-events-none size-full object-contain p-12"
                : shownPreview.kind === "github"
                  ? "pointer-events-none size-full object-cover object-center"
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
      ) : (
        // Ohne Vorschau keine leere Fläche: nächster Regeltermin und Team als Chips.
        <>
          <div
            className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 pb-2"
            data-workjet-project-card-content=""
          >
            <dl className="contents">
              <div
                className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[11px] tabular-nums"
                data-workjet-project-card-jour-fixe=""
              >
                <dt className="sr-only">{t("Regeltermin", "Regular meeting")}</dt>
                <CalendarClockIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <dd>{jourFixeLabel}</dd>
              </div>
              <div
                className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[11px] tabular-nums"
                data-workjet-project-card-lumas={crew?.lumas ?? ""}
              >
                <dt className="sr-only">{t("Lumas", "Lumas")}</dt>
                <UserRoundIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <dd>{crew == null ? "—" : crew.lumas}</dd>
              </div>
              {crew != null && crew.disrupted > 0 ? (
                <div
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-destructive/40 px-2 text-[11px] text-destructive tabular-nums"
                  data-workjet-project-card-disrupted={crew.disrupted}
                >
                  <dt className="sr-only">{t("Gestört", "Disrupted")}</dt>
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />
                  <dd>{`${crew.disrupted} ${t("gestört", "disrupted")}`}</dd>
                </div>
              ) : null}
            </dl>
            {canRate && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setEditing("exit")}
                className="ms-auto"
                data-workjet-action={`project.exit_model.rate:${project.key}`}
              >
                {t("Bewerten", "Rate")}
              </Button>
            )}
          </div>
          {exitValued ? (
            <div className="relative h-20" data-workjet-project-stamp-row="">
              <ProjectExitModelSummary
                projectId={project.id}
                assessment={exitModel ?? null}
                onEdit={archived ? undefined : () => setEditing("exit")}
                editLabel={t("Exit-Bewertung bearbeiten", "Edit exit valuation")}
              />
            </div>
          ) : null}
        </>
      )}
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
            className="relative grid min-w-0 grid-cols-3 gap-2"
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
