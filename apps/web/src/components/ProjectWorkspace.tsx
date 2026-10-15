import { useCallback, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import type { ScopedThreadRef } from "@workjet/contracts";
import { useProjectOverviewLanguage } from "../hooks/useProjectOverviewLanguage";
import { useProjectOverviewSources } from "../hooks/useProjectOverviewSources";
import { useProjectOverviewTokenBudgetSource } from "../hooks/useProjectOverviewTokenBudgetSource";
import { useProjectExitModel } from "../hooks/useProjectExitModel";
import { useSupervisorProjectMetadata } from "../hooks/useSupervisorProjectMetadata";
import { buildProjectOwnerOverview, type ProjectOverviewPr } from "../projectOverviewModel";
import { resolveGalleryProjectOverview, type GalleryProject } from "../projectOverview";
import { useGithubMergedPullRequests } from "../hooks/useGithubMergedPullRequests";
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

type Props = {
  readonly project: GalleryProject;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly onOpenChat: (thread: ScopedThreadRef) => void;
  readonly onOpenJourFixe?: () => void;
  readonly ctoxInstanceId?: string | null;
  readonly openMeeting?: boolean;
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
  onOpenJourFixe,
  ctoxInstanceId,
  openMeeting = false,
  notice,
}: Props) {
  useSupervisorProjectMetadata(project);
  const language = useProjectOverviewLanguage();
  const text = PROJECT_OVERVIEW_TEXT[language];
  const navigate = useNavigate();
  const settingsLinks = [
    {
      label: language === "de" ? "Projekte & Worker" : "Projects & workers",
      onClick: () => void navigate({ to: "/settings/projects" }),
    },
    {
      label: language === "de" ? "Instanz & Kanäle" : "Instance & channels",
      onClick: () => void navigate({ to: "/settings/business-os" }),
    },
  ];
  const nativeInstance = project.native && project.configuration ? (ctoxInstanceId ?? null) : null;
  const sources = useProjectOverviewSources(nativeInstance, project.id);
  const tokenBudgetSource = useProjectOverviewTokenBudgetSource(project);
  const exit = useProjectExitModel(nativeInstance, project.id, project.configuration?.exitModel);
  const githubPrs = useGithubMergedPullRequests(
    resolveGalleryProjectOverview(project).repositoryUrl,
  );
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
    pullRequests: [
      ...Object.values(pullRequests).filter((pr): pr is ProjectOverviewPr => pr !== null),
      ...githubPrs,
    ],
    projectTokenBudgetSource: tokenBudgetSource,
  });
  const [meetingKey, setMeetingKey] = useState<string | null>(null);
  const [dismissedMeetingKey, setDismissedMeetingKey] = useState<string | null>(null);
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
        settingsLinks={settingsLinks}
        feedPersistence={{
          instanceId: nativeInstance,
          configurationId: project.configuration?.id ?? null,
          projectTitle: project.title,
          stored: project.configuration?.feedSettings,
        }}
        connectionMessage={sources.failureText}
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
