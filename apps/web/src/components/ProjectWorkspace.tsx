import { ProjectSupervisorLumaSummary } from "./ProjectSupervisorLumaField";
import { useState } from "react";
import { NativeJourFixeRoom } from "./NativeJourFixeRoom";
import { effectiveSnoozed } from "@workjet/client-runtime/state/thread-settled";
import { selectThreadsForProjectScope } from "@workjet/client-runtime/state/worker-overview";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import type { ScopedThreadRef } from "@workjet/contracts";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import { ArrowUpRightIcon, CalendarDaysIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import {
  groupThreadsByProjectTeam,
  PROJECT_TEAM_SECTIONS,
  projectTeamStatus,
  projectTeamProgressPreview,
  projectTeamHarnessLabel,
  duplicateProjectTeamTitles,
} from "../lib/projectTeamSections";
import {
  type GalleryProject,
  projectUpdateAge,
  resolveGalleryProjectOverview,
} from "../projectOverview";
import { WorkjetHeaderContent } from "./WorkjetHeaderSlots";
import { PersistentWorkerGoal } from "./PersistentWorkerGoal";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";
import { SidebarInset } from "./ui/sidebar";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { suggestedProjectKpis } from "../projectKpiSuggestions";
import { sortPinnedThreadsForSidebar, sortThreadsForSidebar } from "./Sidebar.logic";
import {
  activityHeatmap,
  activityIntervals,
  activitySummary,
  dailyActivity,
  hourlyActivity,
} from "../projectOverviewActivity";

const ACTIVITY_WEEKS = 12;

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

export function ProjectWorkspace({
  project,
  threads,
  onOpenChat,
  onAddParent,
  onOpenJourFixe,
  ctoxInstanceId,
  openMeeting = false,
}: {
  readonly project: GalleryProject;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onOpenChat: (thread: ScopedThreadRef) => void;
  readonly onOpenJourFixe?: () => void;
  readonly ctoxInstanceId?: string | null;
  readonly openMeeting?: boolean;
  readonly onAddParent: (domain: string, goal: string) => Promise<boolean>;
}) {
  const [editingParent, setEditingParent] = useState(false);
  const [meetingKey, setMeetingKey] = useState<string | null>(null);
  const [dismissedMeetingKey, setDismissedMeetingKey] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = project.local;
  const scoped = selectThreadsForProjectScope(
    threads,
    new Set(local === null ? [] : [`${local.environmentId}:${local.id}`]),
  );
  const members = scoped.filter((thread) => {
    const team = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
    return (
      local !== null &&
      thread.projectId === local.id &&
      thread.archivedAt === null &&
      thread.deletedAt == null &&
      !effectiveSnoozed(thread, { now: new Date().toISOString() }) &&
      team?.projectId === thread.projectId &&
      team.threadId === thread.id
    );
  });
  const groups = groupThreadsByProjectTeam([
    ...sortPinnedThreadsForSidebar(members.filter((thread) => thread.pinnedAt != null)),
    ...sortThreadsForSidebar(members.filter((thread) => thread.pinnedAt == null)),
  ]);
  const overview = resolveGalleryProjectOverview(project);
  const duplicateTitles = duplicateProjectTeamTitles(members);
  const info = project.configuration?.info;
  const meeting = project.configuration?.jourFixe;
  const defaults = suggestedProjectKpis(project.title);
  const kpis = ["primary", "secondary", "tertiary"].map((id, index) => ({
    id,
    slot: overview.slots[index] ?? defaults?.[index] ?? null,
  }));
  const now = Date.now();
  const intervals = activityIntervals(
    groups.workers.map((thread) => ({
      key: `${thread.environmentId}:${thread.id}`,
      latestTurn: thread.latestTurn,
    })),
    now,
  );
  const heatmap = activityHeatmap(dailyActivity(intervals), now, ACTIVITY_WEEKS);
  const summary = activitySummary(intervals, heatmap);
  const todayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const hours = hourlyActivity(intervals, todayStart);
  const hourMax = Math.max(1, ...hours);
  const decisions = members.filter(
    (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
  );
  const weekdays = [
    "",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const roomKey = `${ctoxInstanceId}:${project.id}`;
  const nativeRoom =
    project.native && ctoxInstanceId != null && project.configuration !== undefined;
  const openJourFixe =
    onOpenJourFixe ??
    (nativeRoom
      ? () => {
          setDismissedMeetingKey(null);
          setMeetingKey(roomKey);
        }
      : undefined);
  if (nativeRoom && (meetingKey === roomKey || (openMeeting && dismissedMeetingKey !== roomKey)))
    return (
      <SidebarInset className="min-h-0 overflow-auto">
        <NativeJourFixeRoom
          instanceId={ctoxInstanceId}
          projectId={project.configuration!.id}
          projectTitle={project.title}
          onBack={() => {
            setMeetingKey(null);
            setDismissedMeetingKey(roomKey);
          }}
        />
      </SidebarInset>
    );
  return (
    <SidebarInset className="min-h-0 overflow-auto">
      <WorkjetHeaderContent className="flex min-w-0 items-center gap-2 text-sm">
        <WorkspaceBreadcrumb ariaLabel="Project breadcrumb">
          <WorkspaceBreadcrumbItem className="shrink min-w-0">
            <span className="truncate">{project.title}</span>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>Overview</WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkjetHeaderContent>
      <main className="mx-auto w-full max-w-6xl p-6" data-workjet-project-overview={project.id}>
        <header className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{project.title}</h1>
            {(info?.summary ?? info?.description) ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {info?.summary ?? info?.description}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setEditingParent(true)}>
            <PlusIcon className="size-3" />
            Parent
          </Button>
        </header>
        <dl className="mb-6 flex flex-wrap gap-x-8 gap-y-3" data-workjet-overview-kpis="">
          {kpis.map(({ slot, id }) =>
            slot ? (
              <div key={id} className="min-w-0">
                <dd className="text-[22px] font-semibold tracking-tight tabular-nums">
                  {slot.kind === "metric" ? (
                    `${slot.value}${slot.unit ? ` ${slot.unit}` : ""}`
                  ) : slot.kind === "text" ? (
                    slot.value
                  ) : slot.kind === "updated" ? (
                    local?.updatedAt ? (
                      projectUpdateAge(local.updatedAt)
                    ) : (
                      "—"
                    )
                  ) : (
                    <a
                      href={slot.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      ↗
                    </a>
                  )}
                </dd>
                <dt className="max-w-48 break-words text-xs text-muted-foreground">{slot.label}</dt>
              </div>
            ) : null,
          )}
        </dl>
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-6">
            {intervals.length > 0 && (
              <details
                aria-label="Worker activity"
                data-workjet-overview-section="activity"
                className="rounded-lg border border-border p-3"
              >
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Worker activity · {summary.workers} · {formatMinutes(summary.totalMinutes)}
                </summary>
                <p className="mb-4 text-xs text-muted-foreground">Latest worker turns only.</p>
                <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-2">
                  {[
                    ["Workers", String(summary.workers)],
                    ["Active days", String(summary.activeDays)],
                    ["Active time", formatMinutes(summary.totalMinutes)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dd className="text-[22px] font-semibold tracking-tight tabular-nums">
                        {value}
                      </dd>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                    </div>
                  ))}
                </dl>
                <div className="mb-1 text-xs text-muted-foreground">Today, by hour</div>
                <div className="flex h-24 items-end gap-px" data-workjet-activity-hours="">
                  {hours.map((minutes, hour) => (
                    <div
                      key={hour}
                      className="flex-1 rounded-sm bg-primary/70"
                      style={{
                        height: `${Math.max(minutes > 0 ? 4 : 0, (minutes / hourMax) * 100)}%`,
                      }}
                      title={`${String(hour).padStart(2, "0")}:00 · ${formatMinutes(minutes)}`}
                    />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>00:00</span>
                  <span>12:00</span>
                  <span>23:00</span>
                </div>
                <div className="mt-5 mb-1 text-xs text-muted-foreground">
                  Last {ACTIVITY_WEEKS} weeks
                </div>
                <div
                  className="grid grid-flow-col gap-1 overflow-x-auto"
                  style={{ gridTemplateRows: "repeat(7, 12px)", gridAutoColumns: "12px" }}
                  data-workjet-activity-heatmap=""
                >
                  {heatmap.flatMap((row, weekday) =>
                    row.map((cell, week) => (
                      <span
                        key={`${weekday}-${week}`}
                        className="size-3 rounded-[3px] bg-muted"
                        style={{
                          gridRow: weekday + 1,
                          gridColumn: week + 1,
                          opacity: cell ? 0.25 + cell.level * 0.19 : 0.1,
                        }}
                        title={cell ? `${cell.key} · ${formatMinutes(cell.minutes)}` : undefined}
                        aria-hidden="true"
                      />
                    )),
                  )}
                </div>
              </details>
            )}
            {PROJECT_TEAM_SECTIONS.map(({ section, label }) => {
              const group = groups[section];
              if (group.length === 0) return null;
              return (
                <section key={section} aria-label={label} data-workjet-overview-section={section}>
                  <h2 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    {label}
                    {section !== "supervisor" ? <span>{group.length}</span> : null}
                  </h2>
                  <ul className="overflow-hidden rounded-lg border border-border bg-card">
                    {group.map((thread) => {
                      const status = projectTeamStatus(thread);
                      const harness = projectTeamHarnessLabel(thread);
                      const progress = projectTeamProgressPreview(thread);
                      const team =
                        thread.workjetConfig.schemaVersion === 2
                          ? thread.workjetConfig.team
                          : undefined;
                      return (
                        <li
                          key={`${thread.environmentId}:${thread.id}`}
                          className="border-b border-border last:border-0"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              onOpenChat(scopeThreadRef(thread.environmentId, thread.id))
                            }
                            className={
                              section === "supervisor"
                                ? "flex w-full items-start gap-3 bg-muted/20 p-4 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-ring"
                                : "grid w-full grid-cols-[8px_minmax(0,1fr)_44px] items-center gap-3 md:grid-cols-[8px_minmax(0,1.1fr)_minmax(0,1.4fr)_120px_44px] px-3 py-2.5 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-ring"
                            }
                          >
                            {section === "supervisor" ? (
                              <span
                                className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-semibold text-primary"
                                aria-hidden="true"
                              >
                                S
                              </span>
                            ) : null}
                            <span
                              className={`size-2 shrink-0 rounded-full ${status.dot} ${section === "supervisor" ? "mt-2" : ""}`}
                              title={status.label}
                              aria-label={status.label}
                            />
                            {section === "supervisor" ? (
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                  <span className="text-sm font-semibold">{thread.title}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {project.configuration?.supervisorLumaId ? (
                                      <ProjectSupervisorLumaSummary
                                        lumaId={project.configuration.supervisorLumaId}
                                      />
                                    ) : (
                                      "Instance default"
                                    )}
                                    {" · "}
                                    {projectUpdateAge(thread.updatedAt)}
                                  </span>
                                </span>
                                {thread.latestTurn?.assistantMessagePreview ? (
                                  <span className="mt-1 block line-clamp-2 text-sm text-muted-foreground">
                                    {thread.latestTurn.assistantMessagePreview}
                                  </span>
                                ) : null}
                                {team?.goal ? (
                                  <span className="mt-2 inline-block max-w-full rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-muted-foreground">
                                    {team.goal}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <>
                                <span
                                  className="flex min-w-0 items-baseline gap-2 text-sm font-medium"
                                  title={thread.title}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate">{thread.title}</span>
                                    <PersistentWorkerGoal
                                      config={thread.workjetConfig}
                                      sessionStatus={thread.session?.status}
                                      hasPendingApprovals={thread.hasPendingApprovals}
                                      hasPendingUserInput={thread.hasPendingUserInput}
                                      compact
                                    />
                                  </span>
                                  {duplicateTitles.has(thread.title) ? (
                                    <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                                      {harness}
                                    </span>
                                  ) : null}
                                </span>
                                <span
                                  className="hidden min-w-0 truncate text-xs text-muted-foreground md:block"
                                  title={progress || status.label}
                                >
                                  {progress || (status.label === "Idle" ? "" : status.label)}
                                  {section === "workers" && thread.branch ? (
                                    <span className="inline-flex items-center gap-1">
                                      <GitBranchIcon className="size-3" />
                                      {thread.branch}
                                    </span>
                                  ) : null}
                                </span>
                                <span
                                  className="hidden truncate text-[11px] text-muted-foreground md:block"
                                  title={`${harness} · ${thread.modelSelection.model}`}
                                >
                                  {harness} · {thread.modelSelection.model}
                                </span>
                                <span className="text-right text-[11px] text-muted-foreground">
                                  {projectUpdateAge(thread.updatedAt)}
                                </span>
                              </>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
          <aside className="space-y-4 text-sm">
            {decisions.length > 0 ? (
              <section className="rounded-lg border border-border p-3">
                <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                  Open decisions · {decisions.length}
                </h2>
                {decisions.map((thread) => (
                  <button
                    type="button"
                    key={`${thread.environmentId}:${thread.id}`}
                    onClick={() => onOpenChat(scopeThreadRef(thread.environmentId, thread.id))}
                    className="block w-full truncate py-1 text-left text-sm hover:underline"
                  >
                    {thread.title}
                  </button>
                ))}
              </section>
            ) : null}
            {meeting || openJourFixe ? (
              <section className="rounded-lg border border-border p-4">
                <h2 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <CalendarDaysIcon className="size-4" />
                  Jour fixe
                </h2>
                {meeting ? (
                  <>
                    <p>
                      {weekdays[meeting.weekday]} · {meeting.time}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{meeting.timezone}</p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No recurring time is set yet.</p>
                )}
                {openJourFixe && (
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={openJourFixe}
                    data-workjet-action="project.jour-fixe.open"
                  >
                    Join Jour fixe
                  </Button>
                )}
              </section>
            ) : null}
            {info?.goal ? (
              <section>
                <h2 className="mb-2 text-xs font-medium text-muted-foreground">Project goal</h2>
                <p>{info.goal}</p>
              </section>
            ) : null}
            {info?.phase || info?.status ? (
              <p className="text-xs text-muted-foreground">
                {[info.phase, info.status].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            {overview.websiteUrl || overview.repositoryUrl ? (
              <section className="space-y-2">
                <h2 className="text-xs font-medium text-muted-foreground">Links</h2>
                {[
                  ["Website", overview.websiteUrl],
                  ["Repository", overview.repositoryUrl],
                ].map(([label, url]) =>
                  url ? (
                    <a
                      key={label}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-2 hover:underline"
                    >
                      {label}
                      <ArrowUpRightIcon className="size-3" />
                    </a>
                  ) : null,
                )}
              </section>
            ) : null}
          </aside>
        </div>
      </main>
      <Dialog
        open={editingParent}
        onOpenChange={(open) => {
          if (!saving) setEditingParent(open);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add parent</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <form
              className="grid gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                if (saving || !domain.trim() || !goal.trim()) return;
                setSaving(true);
                setError(null);
                try {
                  if (!(await onAddParent(domain.trim(), goal.trim())))
                    throw new Error("Could not save this parent.");
                  setEditingParent(false);
                  setDomain("");
                  setGoal("");
                } catch {
                  setError("Could not save this parent. Check the connection and model settings.");
                } finally {
                  setSaving(false);
                }
              }}
            >
              <label className="grid gap-1 text-sm">
                Name
                <Input
                  required
                  maxLength={256}
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Goal
                <textarea
                  required
                  maxLength={4096}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  className="min-h-24 rounded-md border border-input bg-transparent p-2"
                />
              </label>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Add parent"}
              </Button>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
