import { useCallback, useState, type ReactNode } from "react";
import { GitPullRequestIcon } from "lucide-react";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import type { ScopedThreadRef } from "@workjet/contracts";
import { useProjectOverviewLanguage } from "../hooks/useProjectOverviewLanguage";
import { useProjectOverviewSources } from "../hooks/useProjectOverviewSources";
import { useProjectOverviewTokenBudgetSource } from "../hooks/useProjectOverviewTokenBudgetSource";
import { useProjectExitModel } from "../hooks/useProjectExitModel";
import { useSupervisorProjectMetadata } from "../hooks/useSupervisorProjectMetadata";
import { buildProjectOwnerOverview, type ProjectOverviewPr } from "../projectOverviewModel";
import type { GalleryProject } from "../projectOverview";
import { PROJECT_OVERVIEW_TEXT } from "../projectOverviewText";
import { ProjectOverviewView } from "./ProjectOverviewView";
import { ProjectOverviewDecisions } from "./ProjectOverviewDecisions";
import { ProjectOverviewPullRequest } from "./ProjectOverviewPullRequest";
import { NativeJourFixeRoom } from "./NativeJourFixeRoom";
import { WorkjetHeaderContent } from "./WorkjetHeaderSlots";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";
import { SidebarInset } from "./ui/sidebar";
import { InlinePanel } from "./ui/inline-panel";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

type Props = {
  readonly project: GalleryProject;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onOpenChat: (thread: ScopedThreadRef) => void;
  readonly onOpenJourFixe?: () => void;
  readonly ctoxInstanceId?: string | null;
  readonly openMeeting?: boolean;
  readonly onAddParent: (domain: string, goal: string) => Promise<boolean>;
  /** Öffnet die Pull-Request-Liste dieses Projekts. */
  readonly onOpenPullRequests?: () => void;
  /** Compact one-line notice above the overview, e.g. a missing model account. */
  readonly notice?: ReactNode;
};
export function ProjectWorkspace(props: Props) {
  return (
    <ProjectWorkspaceContent
      key={(props.ctoxInstanceId ?? "local") + ":" + props.project.id}
      {...props}
    />
  );
}
function ProjectWorkspaceContent({
  project,
  threads,
  onOpenChat,
  onAddParent,
  onOpenJourFixe,
  onOpenPullRequests,
  ctoxInstanceId,
  openMeeting = false,
  notice,
}: Props) {
  useSupervisorProjectMetadata(project);
  const language = useProjectOverviewLanguage();
  const text = PROJECT_OVERVIEW_TEXT[language];
  const nativeInstance = project.native && project.configuration ? (ctoxInstanceId ?? null) : null;
  const sources = useProjectOverviewSources(nativeInstance, project.id);
  const tokenBudgetSource = useProjectOverviewTokenBudgetSource(project);
  const exit = useProjectExitModel(nativeInstance, project.id, project.configuration?.exitModel);
  const [pullRequests, setPullRequests] = useState<Record<string, ProjectOverviewPr | null>>({});
  const onReadPr = useCallback(
    (key: string, pr: ProjectOverviewPr | null) =>
      setPullRequests((previous) => (previous[key] === pr ? previous : { ...previous, [key]: pr })),
    [],
  );
  const data = buildProjectOwnerOverview({
    project:
      project.configuration && exit.assessment
        ? { ...project, configuration: { ...project.configuration, exitModel: exit.assessment } }
        : project,
    threads,
    language,
    meeting: sources.meeting,
    kpis: sources.kpis,
    pullRequests: Object.values(pullRequests).filter((pr): pr is ProjectOverviewPr => pr !== null),
    projectTokenBudgetSource: tokenBudgetSource,
  });
  const [editingParent, setEditingParent] = useState(false);
  const [meetingKey, setMeetingKey] = useState<string | null>(null);
  const [dismissedMeetingKey, setDismissedMeetingKey] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitParent = async () => {
    if (saving || !domain.trim() || !goal.trim()) return;
    setSaving(true);
    setFailed(false);
    try {
      if (await onAddParent(domain.trim(), goal.trim())) {
        setEditingParent(false);
        setDomain("");
        setGoal("");
      } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
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
    <SidebarInset className="min-h-0 min-w-0 overflow-auto">
      <WorkjetHeaderContent className="flex min-w-0 items-center gap-2 text-[13.5px]">
        <WorkspaceBreadcrumb ariaLabel={text.overview}>
          <WorkspaceBreadcrumbItem className="min-w-0 shrink">
            <span className="truncate">{project.title}</span>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>{text.overview}</WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkjetHeaderContent>
      {notice ? (
        <div
          role="status"
          className="mx-5 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:mx-6"
          data-workjet-project-notice=""
        >
          {notice}
        </div>
      ) : null}
      <ProjectOverviewView
        data={data}
        onOpenChat={onOpenChat}
        {...(openJourFixe ? { onOpenJourFixe: openJourFixe } : {})}
        connectionError={sources.failed}
        onRecomputeKpis={sources.reload}
        feedPosts={sources.feedPosts}
        connectionMessage={sources.failureText}
        actions={
          <>
            {onOpenPullRequests ? (
              <Button size="sm" variant="outline" onClick={onOpenPullRequests}>
                <GitPullRequestIcon />
                Pull Requests
              </Button>
            ) : null}
            <InlinePanel
              // The header row wraps; an open panel takes its own full line.
              {...(editingParent
                ? { className: "mt-2 basis-full text-[13.5px] text-foreground" }
                : {})}
              triggerLabel={text.addParent}
              open={editingParent}
              onOpenChange={(open) => {
                setEditingParent(open);
                if (!open) setFailed(false);
              }}
              submitLabel={saving ? text.saving : text.addParent}
              submitDisabled={!domain.trim() || !goal.trim()}
              busy={saving}
              status={failed ? text.addFailed : undefined}
              statusTone="error"
              onSubmit={() => void submitParent()}
            >
              <label className="grid gap-1 text-[13.5px]">
                {text.name}
                <Input
                  required
                  maxLength={256}
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-[13.5px]">
                {text.goal}
                <textarea
                  required
                  maxLength={4096}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  className="min-h-24 rounded-md border border-input bg-transparent p-2"
                />
              </label>
            </InlinePanel>
          </>
        }
        {...(data.decisions.length
          ? {
              decisions: (
                <div>
                  {data.decisions.map((thread) => (
                    <ProjectOverviewDecisions
                      key={thread.environmentId + ":" + thread.id}
                      thread={thread}
                      language={language}
                      onOpenChat={onOpenChat}
                    />
                  ))}
                </div>
              ),
            }
          : {})}
      />
      {data.all
        .filter((thread) => thread.branch != null && thread.worktreePath != null)
        .map((thread) => (
          <ProjectOverviewPullRequest
            key={thread.environmentId + ":" + thread.id}
            thread={thread}
            projectCwd={project.local?.workspaceRoot ?? null}
            onRead={onReadPr}
          />
        ))}
    </SidebarInset>
  );
}
