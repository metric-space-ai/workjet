import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ThreadId,
  type WorkjetProjectTeamMember,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import { ProjectTeamPanel } from "./ProjectTeamPanel";

type TeamThread = ComponentProps<typeof ProjectTeamPanel>["thread"];
const projectId = ProjectId.make("project");
const modelSelection = Schema.decodeUnknownSync(ModelSelection)({
  instanceId: "codex",
  model: "gpt-6.1-sol",
});
const supervisorId = ThreadId.make("supervisor");
const specialistId = ThreadId.make("specialist");
const workerId = ThreadId.make("worker");
const base = { projectId, goal: "Deliver the project", createdAt: "2026-10-03T12:00:00Z" };
function fixture(member: WorkjetProjectTeamMember, title: string): TeamThread {
  const workjetConfig: WorkjetThreadConfig =
    member.role === "worker"
      ? {
          ...DEFAULT_WORKJET_THREAD_CONFIG,
          role: "worker",
          parent: { environmentId: EnvironmentId.make("fixture"), threadId: member.parentThreadId },
          team: member,
        }
      : { ...DEFAULT_WORKJET_THREAD_CONFIG, role: "orchestrator", team: member };
  return { id: member.threadId, projectId: member.projectId, title, modelSelection, workjetConfig };
}
const supervisor = fixture(
  { ...base, role: "supervisor", threadId: supervisorId, parentThreadId: null },
  "Project coordination",
);
const specialist = fixture(
  {
    ...base,
    role: "specialist",
    threadId: specialistId,
    parentThreadId: supervisorId,
    domain: "UI",
  },
  "Interface specialist",
);
const worker = fixture(
  { ...base, role: "worker", threadId: workerId, parentThreadId: specialistId, packageId: "pr-73" },
  "Fix gallery navigation",
);
function render(thread: TeamThread, threads: readonly TeamThread[]) {
  return renderToStaticMarkup(
    <ProjectTeamPanel
      thread={thread}
      threads={threads}
      onOpen={() => {}}
      onAddSpecialist={async () => true}
      onSaveGoal={async () => true}
      onCreateSupervisor={async () => true}
    />,
  );
}
describe("ProjectTeamPanel directory", () => {
  it("shows all three persisted team roles from the supervisor, including its grandchild worker", () => {
    const markup = render(supervisor, [worker, specialist, supervisor]);
    expect(markup).toContain('data-workjet-team-group="supervisor"');
    expect(markup).toContain('data-workjet-team-group="specialist"');
    expect(markup).toContain('data-workjet-team-group="worker"');
    expect(markup).toContain("Fach-Lumas");
    expect(markup).toContain("One-time PR threads");
    expect(markup).toContain("Interface specialist");
    expect(markup).toContain("Fix gallery navigation");
    expect(markup).toContain("Parent: Interface specialist");
    expect(markup).toContain('aria-current="page"');
  });

  it("keeps foreign projects, archived history and mismatched membership out of the active directory", () => {
    const markup = render(supervisor, [
      supervisor,
      { ...specialist, title: "Archived specialist", archivedAt: "2026-10-03T12:01:00Z" },
      { ...worker, title: "Deleted worker", deletedAt: "2026-10-03T12:01:00Z" },
      { ...specialist, title: "Foreign specialist", projectId: ProjectId.make("foreign-project") },
      { ...worker, title: "Wrong identity", id: ThreadId.make("different-worker") },
      {
        id: ThreadId.make("unclassified"),
        projectId,
        title: "Fach-Lumas title is not a role",
        modelSelection,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
      },
    ]);
    for (const title of [
      "Archived specialist",
      "Deleted worker",
      "Foreign specialist",
      "Wrong identity",
      "Fach-Lumas title is not a role",
    ])
      expect(markup).not.toContain(title);
    expect(markup).toContain("No Fach-Lumas yet.");
    expect(markup).toContain("No one-time PR threads yet.");
  });

  it("retains team navigation from an unclassified legacy conversation without inventing membership", () => {
    const legacy = {
      id: ThreadId.make("legacy"),
      projectId,
      title: "Legacy imported conversation",
      modelSelection,
      workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
    };
    const markup = render(legacy, [legacy, supervisor, specialist, worker]);
    expect(markup).toContain("Open project supervisor");
    expect(markup).toContain("Fix gallery navigation");
    expect(markup).not.toContain("Create project supervisor");
    expect(markup).not.toContain("Legacy imported conversation");
  });
});
