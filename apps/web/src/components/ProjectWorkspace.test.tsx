import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@workjet/contracts";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { GalleryProject } from "../projectOverview";

const source = EnvironmentId.make("desktop");
const target = EnvironmentId.make("gpu3");
const projectId = ProjectId.make("real-project");
const parentId = ThreadId.make("supervisor");
const createdAt = "2026-10-07T00:00:00Z";
const project: GalleryProject = {
  key: "native:real-project",
  id: projectId,
  title: "Remote project",
  native: true,
  local: {
    id: projectId,
    environmentId: source,
    title: "Remote project",
    updatedAt: createdAt,
    overview: null,
    ctoxRegistration: null,
    faviconPath: null,
  },
};
function shell(
  environmentId: EnvironmentId,
  role: "supervisor" | "worker",
  archivedAt: string | null = null,
): EnvironmentThreadShell {
  const id = role === "supervisor" ? parentId : ThreadId.make("remote-worker");
  const base = {
    id,
    environmentId,
    projectId,
    title: role === "worker" ? "Build on gpu3" : "Source supervisor",
    branch: role === "worker" ? "codex/remote-work" : null,
    archivedAt,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
    pinnedAt: null,
    snoozedUntil: null,
    session: null,
    latestTurn: null,
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      role: role === "worker" ? "worker" : "orchestrator",
      parent: role === "worker" ? { environmentId: source, threadId: parentId } : null,
      team: {
        role,
        projectId,
        threadId: id,
        parentThreadId: role === "worker" ? parentId : null,
        packageId: "one-pr",
        goal: "Ship the project",
        createdAt,
      },
    },
  };
  return base as unknown as EnvironmentThreadShell;
}
function markup(threads: readonly EnvironmentThreadShell[]) {
  return renderToStaticMarkup(
    <ProjectWorkspace
      project={project}
      threads={threads}
      onOpenChat={() => {}}
      onAddParent={async () => true}
    />,
  );
}

describe("project worker activity", () => {
  it("omits an empty activity panel instead of showing unknown history as zero", () => {
    const html = markup([shell(source, "supervisor")]);
    expect(html).not.toContain('data-workjet-overview-section="activity"');
  });
  it("counts actual worker turns without including supervisor work", () => {
    const completed = (thread: EnvironmentThreadShell) => ({
      ...thread,
      latestTurn: {
        requestedAt: new Date(Date.now() - 3600000).toISOString(),
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        completedAt: new Date().toISOString(),
      },
    }) as unknown as EnvironmentThreadShell;
    const html = markup([
      completed(shell(source, "supervisor")),
      completed(shell(target, "worker")),
    ]);
    expect(html).toContain('data-workjet-overview-section="activity"');
    expect(html).toContain("Worker activity · 1 ·");
    expect(html).toContain("Latest worker turns only.");
    expect(html).not.toContain("Worker activity · 2 ·");
  });
});

describe("project Jour fixe entry", () => {
  it("offers joining from the overview even when no recurring time is configured", () => {
    const html = renderToStaticMarkup(
      <ProjectWorkspace
        project={project}
        threads={[shell(source, "supervisor")]}
        onOpenChat={() => {}}
        onOpenJourFixe={() => {}}
        onAddParent={async () => true}
      />,
    );
    expect(html).toContain("Join Jour fixe");
    expect(html).toContain("No recurring time is set yet.");
  });
});

describe("source project remote workers", () => {
  it("renders the target computer worker in the source project's Workers group", () => {
    const html = markup([shell(source, "supervisor"), shell(target, "worker")]);
    expect(html).toContain('data-workjet-overview-section="workers"');
    expect(html).toContain("Build on gpu3");
    expect(html).toContain("codex/remote-work");
  });
  it("keeps retained archived workers out of the Workers group", () => {
    const html = markup([shell(source, "supervisor"), shell(target, "worker", createdAt)]);
    expect(html).not.toContain('data-workjet-overview-section="workers"');
    expect(html).not.toContain("Build on gpu3");
  });
  it("does not render a remote worker with a missing source parent", () => {
    expect(markup([shell(target, "worker")])).not.toContain("Build on gpu3");
  });
});
