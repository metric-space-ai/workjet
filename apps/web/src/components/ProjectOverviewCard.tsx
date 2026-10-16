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
import { CalendarClockIcon, EllipsisIcon, UserRoundIcon, XIcon } from "lucide-react";
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
import { stackedThreadToast, toastManager } from "./ui/toast";
import { UNDO_DELETE_MS } from "../lib/undoableDelete";
import { ProjectKpiTile } from "./ProjectKpiTile";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectInitProgress } from "./ProjectInitProgress";
import { useProjectOverviewLanguage } from "../hooks/useProjectOverviewLanguage";
import { PROJECT_OVERVIEW_TEXT, projectOverviewFormat } from "../projectOverviewText";
import { Button } from "./ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { workjetUiLanguage } from "../workjetProjectControl";
import { useSingleInlineExpand } from "./ui/inline-expand";

/** Workers of a project on its card: who is on the team now, and how many are disrupted. */
export type ProjectCardCrew = { readonly workers: number; readonly disrupted: number };

/**
 * Team state for the card's content area, from the project's own histories: the
 * supervisor and fixed workers always count, one-time workers while they work or are disrupted.
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
  return { workers: team.length, disrupted: team.filter(disrupted).length };
}

const JOUR_FIXE_WEEKDAYS = {
  de: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
} as const;

/** „Di · 10:00“: weekday and time of the weekly Regeltermin; `null` without one. */
export function projectCardJourFixeLabel(
  jourFixe: { readonly weekday: number; readonly time: string } | null | undefined,
  language: "de" | "en",
): string | null {
  const weekday = jourFixe ? JOUR_FIXE_WEEKDAYS[language][jourFixe.weekday - 1] : undefined;
  return jourFixe && weekday ? `${weekday} · ${jourFixe.time}` : null;
}

/** One or two letters for the calm placeholder of a card without content. */
export function projectCardMonogram(title: string): string {
  const words = title
    .trim()
    .split(/[\s_-]+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words
    .slice(0, 2)
    .map((word) => (word.match(/[\p{L}\p{N}]/u)?.[0] ?? "").toLocaleUpperCase())
    .join("");
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
/**
 * Silent retries of a preview image that failed to load. GitHub's social-preview
 * renderer answers bursts of uncached repositories with HTTP 429, so the first
 * retry comes quickly and later ones back off.
 */
const PREVIEW_RETRY_MS = [15_000, 60_000, 5 * 60_000] as const;

/**
 * GitHub answers private or unknown repositories with its generic 1200×630 Octocat
 * card; real repository cards are 2:1. The generic card counts as no preview.
 */
/**
 * Without a preview and without content the card shows its monogram. A preview that
 * failed (or was GitHub's generic card) always falls back to it, even beside a stamp.
 */
export function showsProjectCardMonogram(input: {
  readonly hasContent: boolean;
  readonly exitValued: boolean;
  readonly previewFailed: boolean;
}): boolean {
  return !input.hasContent && (!input.exitValued || input.previewFailed);
}

export function isGenericGithubPreview(width: number, height: number): boolean {
  return width > 0 && height > 0 && Math.abs(width / height - 2) > 0.05;
}

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
  const [previewAttempts, setPreviewAttempts] = useState(0);
  const [genericPreviewImage, setGenericPreviewImage] = useState<string | null>(null);
  const pressedAt = useRef<{ readonly x: number; readonly y: number } | null>(null);
  /** Which card action failed last, so "Erneut versuchen" repeats exactly that one. */
  const lastFailed = useRef<"refresh" | "archive">("archive");
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
    project.local as {
      readonly repositoryIdentity?: ProjectPreviewRepositoryIdentity | null;
    } | null
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
    !archived &&
    preview !== null &&
    failedPreviewImage !== preview.image &&
    genericPreviewImage !== preview.image
      ? preview
      : null;
  // A preview that exists but did not load falls back to the monogram like an empty card.
  const previewFailed = !archived && preview !== null && shownPreview === null;
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
    if (!ok) {
      lastFailed.current = "refresh";
      setArchiveError(t("Neuberechnung nicht erreichbar.", "Recalculation not reachable."));
    }
  };
  const closeEditing = () => setEditing(null);
  // A failed preview (GitHub rate limit, offline) is retried silently; meanwhile the
  // card shows its content instead of an empty area.
  useEffect(() => {
    if (failedPreviewImage === null) return;
    const delay = PREVIEW_RETRY_MS[Math.min(previewAttempts, PREVIEW_RETRY_MS.length - 1)];
    const timer = window.setTimeout(() => {
      setPreviewAttempts((attempts) => attempts + 1);
      setFailedPreviewImage(null);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [failedPreviewImage, previewAttempts]);
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
      // Sofortspeichern + Rückgängig statt Bestätigung (UI-Regel, #798): der Toast stellt
      // den vorherigen Stand wieder her, auch wenn die Karte inzwischen aus der Liste ist.
      const previous = overview;
      const save = onSave;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: archived
            ? t(`${project.title} wiederhergestellt`, `${project.title} restored`)
            : t(`${project.title} archiviert`, `${project.title} archived`),
          timeout: UNDO_DELETE_MS,
          actionProps: {
            children: t("Rückgängig", "Undo"),
            onClick: () => void save(previous),
          },
        }),
      );
      return true;
    } catch {
      lastFailed.current = "archive";
      setArchiveError(t("Projekt nicht gespeichert.", "Project not saved."));
      return false;
    } finally {
      setArchivePending(false);
    }
  };
  // KPI slots with data only: a value without data drops out with its label, and a
  // card without any value has no KPI strip at all.
  const kpiSlots = (["first", "second", "third"] as const).flatMap((position, index) => {
    if (project.native && knownKpis) {
      // Leer und gerade im Editor: nur die erste Kachel, aufgeklappt.
      if (kpisEmpty ? index > 0 || editingKpi !== 0 : !knownKpis.items[index]) return [];
      return [
        <ProjectKpiTile
          key={position}
          projectId={project.id}
          index={index}
          kpis={knownKpis}
          expanded={editingKpi === index}
          onExpandedChange={(open) => setEditingKpi(open ? index : null)}
          onSave={onSaveKpis}
          onRefresh={onRefreshKpis}
        />,
      ];
    }
    // Native KPIs unbekannt (nie gelesen, Lesen gescheitert, kein gespeicherter
    // Stand): nur ein selbst gesetzter Wert der Kachel bleibt.
    if (project.native && !overview.slots[index]) return [];
    const slot = slots[index] ?? null;
    if (slot === null) return [];
    if (slot.kind === "updated" && activityAt === null) return [];
    if (slot.kind === "text" && (slot.value.trim() === "" || slot.value.trim() === "—")) return [];
    return [
      <div
        key={position}
        className="flex min-h-12 min-w-0 flex-col gap-0.5"
        data-workjet-project-card-slot={index + 1}
      >
        <dt
          title={slot.label}
          className="min-w-0 break-words text-[11px] leading-4 text-muted-foreground line-clamp-2"
        >
          {slot.label}
        </dt>
        <dd
          className={
            // A relative time ("vor 3 Tagen") stays on one line at content size (Audit A-26).
            slot.kind === "updated"
              ? "order-first min-w-0 truncate text-[13.5px] leading-7 font-semibold tabular-nums"
              : "order-first min-w-0 break-words text-[22px] leading-7 font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]"
          }
        >
          {slot.kind === "link" ? (
            <Button
              size="xs"
              variant="outline"
              render={<a href={slot.url} target="_blank" rel="noreferrer noopener" />}
            >
              {t("Link öffnen", "Open link")}
            </Button>
          ) : slot.kind === "updated" ? (
            <time dateTime={activityAt ?? undefined} title={activityAt ?? undefined}>
              {activityAt === null ? null : projectUpdateAge(activityAt)}
            </time>
          ) : slot.kind === "metric" ? (
            `${slot.value}${slot.unit ? ` ${slot.unit}` : ""}`
          ) : (
            slot.value
          )}
        </dd>
      </div>,
    ];
  });
  // ⋯ only when it holds at least one action (Audit A-33).
  const canRefreshFromMenu = Boolean(onRefreshKpis && scopedKpis && scopedKpis.items.length > 0);
  const hasMenuEntries =
    canRefreshFromMenu ||
    configureCard !== undefined ||
    Boolean(website && titleIsWebsite) ||
    Boolean(repository) ||
    Boolean(onSave && canArchive);
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
      className="relative flex h-full min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
          {/* A title that already is the domain gets no second domain line (Audit A-25);
              the website stays one click away in the ⋯ menu. */}
          {website && !titleIsWebsite && (
            <a
              href={website}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={projectOverviewFormat(text.cardOpenWebsiteLabel, {
                title: project.title,
                url: website,
              })}
              data-workjet-action={`project.open.website:${project.key}`}
              className="block truncate text-[12px] text-muted-foreground hover:text-foreground"
            >
              {websiteHost}
            </a>
          )}
        </div>
        {tokenBudget}
        {/* Mit Vorschaubild sitzt „Bewerten“ im Kopf neben ⋯, nie über dem Bild (N3). */}
        {canRate && hasPreview && editing === null ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setEditing("exit")}
            className="shrink-0"
            data-workjet-action={`project.exit_model.rate:${project.key}`}
          >
            {t("Bewerten", "Rate")}
          </Button>
        ) : null}
        {reorderHandle}
        {hasMenuEntries && (
          <Menu>
            <MenuTrigger
              aria-label={t(`Aktionen für ${project.title}`, `Actions for ${project.title}`)}
              render={<Button size="xs" variant="ghost" className="shrink-0" />}
              data-workjet-action={`project.card.menu:${project.key}`}
            >
              <EllipsisIcon className="size-4" aria-hidden="true" />
              {t("Mehr", "More")}
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
                    : t("Kennzahlen neu berechnen", "Recalculate metrics")}
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
              {website && titleIsWebsite && (
                <MenuItem render={<a href={website} target="_blank" rel="noreferrer noopener" />}>
                  {t("Webseite öffnen", "Open website")}
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
        )}
      </div>
      {editing !== null ? (
        <div
          className="relative flex min-h-[calc(var(--spacing)*40)] flex-col bg-muted/40"
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
            aria-label={t("Fertig", "Done")}
            title={t("Fertig", "Done")}
            onClick={closeEditing}
            data-workjet-action={`project.card.close:${project.key}`}
            className="absolute top-1.5 right-1.5 z-10"
          >
            <XIcon aria-hidden className="size-4" />
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
            onLoad={(event) => {
              const image = event.currentTarget;
              if (
                shownPreview.kind === "github" &&
                isGenericGithubPreview(image.naturalWidth, image.naturalHeight)
              )
                setGenericPreviewImage(shownPreview.image);
            }}
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
        </div>
      ) : (
        // Ohne Vorschau keine leere Fläche: nächster Regeltermin und Worker, soweit
        // bekannt. Ohne jeden Wert bleibt die Fläche ruhig mit dem Projekt-Monogramm.
        <>
          {jourFixeLabel !== null || crew != null || canRate ? (
            <div
              className="flex min-h-20 min-w-0 flex-1 flex-col justify-center gap-2 px-3 py-3"
              data-workjet-project-card-content=""
            >
              {jourFixeLabel !== null || crew != null ? (
                <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  {jourFixeLabel !== null ? (
                    <div
                      className="flex min-w-0 flex-col gap-0.5"
                      data-workjet-project-card-jour-fixe=""
                    >
                      <dt className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
                        <CalendarClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        {t("Regeltermin", "Regular meeting")}
                      </dt>
                      <dd className="order-first truncate text-[22px] leading-7 font-semibold tracking-tight tabular-nums">
                        {jourFixeLabel}
                      </dd>
                    </div>
                  ) : null}
                  {crew != null ? (
                    <div
                      className="flex min-w-0 flex-col gap-0.5"
                      data-workjet-project-card-workers={crew.workers}
                    >
                      <dt className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
                        <UserRoundIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        Worker
                      </dt>
                      <dd className="order-first flex min-w-0 items-center gap-1.5">
                        <span className="text-[22px] leading-7 font-semibold tracking-tight tabular-nums">
                          {crew.workers}
                        </span>
                        {crew.disrupted > 0 ? (
                          // Red dot plus number, no pill (Audit A-13).
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-[12px] text-destructive-foreground tabular-nums"
                            data-workjet-project-card-disrupted={crew.disrupted}
                            aria-label={`${crew.disrupted} ${t("gestört", "disrupted")}`}
                            title={`${crew.disrupted} ${t("gestört", "disrupted")}`}
                          >
                            <span
                              aria-hidden="true"
                              className="size-2 rounded-full bg-destructive"
                            />
                            {crew.disrupted}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
              {canRate && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setEditing("exit")}
                  className="self-start"
                  data-workjet-action={`project.exit_model.rate:${project.key}`}
                >
                  {t("Bewerten", "Rate")}
                </Button>
              )}
            </div>
          ) : null}
          {showsProjectCardMonogram({
            hasContent: jourFixeLabel !== null || crew != null || canRate,
            exitValued,
            previewFailed,
          }) ? (
            <div
              className="flex min-h-20 flex-1 items-center justify-center"
              data-workjet-project-card-monogram=""
            >
              <span
                aria-hidden="true"
                className="flex size-12 items-center justify-center rounded-lg bg-muted/60 text-[22px] font-semibold text-muted-foreground/70"
              >
                {projectCardMonogram(project.title)}
              </span>
            </div>
          ) : null}
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
      {kpisEmpty && onSaveKpis && editingKpi === null ? (
        <div className="mt-auto border-t border-border px-3 py-3">
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
        </div>
      ) : kpiSlots.length > 0 ? (
        // Not positioned: an open KPI editor overlays the whole card (Audit A-30).
        <div className="mt-auto border-t border-border px-3 py-3">
          <dl className="grid min-w-0 grid-cols-3 gap-2" data-workjet-project-card-slots="">
            {kpiSlots}
          </dl>
        </div>
      ) : null}
      {archiveError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-destructive-foreground"
        >
          <span>{archiveError}</span>
          <Button
            size="xs"
            variant="outline"
            data-workjet-action={`project.card.retry:${project.key}`}
            onClick={() =>
              void (lastFailed.current === "refresh" ? refreshKpis() : changeArchive())
            }
          >
            {t("Erneut versuchen", "Try again")}
          </Button>
        </div>
      )}
    </article>
  );
}
