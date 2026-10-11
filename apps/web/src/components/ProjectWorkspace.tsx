import { useCallback, useState } from "react";
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
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Props = {
  readonly project: GalleryProject;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onOpenChat: (thread: ScopedThreadRef) => void;
  readonly onOpenJourFixe?: () => void;
  readonly ctoxInstanceId?: string | null;
  readonly openMeeting?: boolean;
  readonly onAddParent: (domain: string, goal: string) => Promise<boolean>;
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
  ctoxInstanceId,
  openMeeting = false,
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
      <WorkjetHeaderContent className="flex min-w-0 items-center gap-2 text-sm">
        <WorkspaceBreadcrumb ariaLabel={text.overview}>
          <WorkspaceBreadcrumbItem className="min-w-0 shrink">
            <span className="truncate">{project.title}</span>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>{text.overview}</WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkjetHeaderContent>
      <ProjectOverviewView
        data={data}
        onOpenChat={onOpenChat}
        {...(openJourFixe ? { onOpenJourFixe: openJourFixe } : {})}
        connectionError={sources.failed}
        actions={
          <button
            type="button"
            onClick={() => setEditingParent(true)}
            className="mt-2 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted"
          >
            + {text.addParent}
          </button>
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
      <Dialog open={editingParent} onOpenChange={setEditingParent}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{text.addParent}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <form
              className="grid gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
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
              }}
            >
              <label className="grid gap-1 text-sm">
                {text.name}
                <Input
                  required
                  maxLength={256}
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {text.goal}
                <textarea
                  required
                  maxLength={4096}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  className="min-h-24 rounded-md border border-input bg-transparent p-2"
                />
              </label>
              {failed && (
                <p role="alert" className="text-sm text-muted-foreground">
                  {text.addFailed}
                </p>
              )}
              <Button type="submit" disabled={saving}>
                {saving ? text.saving : text.addParent}
              </Button>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
