import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@workjet/contracts";
import { resolveGalleryProjectStatistics, type GalleryProject } from "./projectOverview";
const project: GalleryProject = {
  key: "tenant:project",
  id: "native",
  title: "Example",
  native: true,
  local: {
    id: ProjectId.make("local"),
    environmentId: EnvironmentId.make("own"),
    title: "Example",
    updatedAt: "2026-10-01T08:00:00Z",
    ctoxRegistration: null,
  },
};
const thread = (
  change: Partial<{
    environmentId: string;
    projectId: string;
    updatedAt: string;
    archivedAt: string | null;
    deletedAt: string | null;
    session: { status: string } | null;
  }> = {},
) => ({
  environmentId: "own",
  projectId: "local",
  updatedAt: "2026-10-02T08:00:00Z",
  archivedAt: null,
  deletedAt: null,
  session: { status: "ready" },
  ...change,
});
describe("gallery KPI scope", () => {
  it("uses only retained chats in the exact identity-bound project and environment", () => {
    const result = resolveGalleryProjectStatistics(
      project,
      [
        thread({ session: { status: "running" } }),
        thread({ session: { status: "starting" }, updatedAt: "2026-10-03T08:00:00Z" }),
        thread({ archivedAt: "2026-10-03T09:00:00Z", session: { status: "running" } }),
        thread({ deletedAt: "2026-10-04T08:00:00Z" }),
        thread({
          environmentId: "foreign",
          updatedAt: "2026-10-07T08:00:00Z",
          session: { status: "running" },
        }),
        thread({ projectId: "different", updatedAt: "2026-10-07T08:00:00Z" }),
      ],
      true,
    );
    expect(result).toEqual({
      chatCount: 3,
      activeChatCount: 2,
      lastActivityAt: "2026-10-03T08:00:00Z",
    });
  });
  it("distinguishes missing histories from a confirmed empty project", () => {
    expect(resolveGalleryProjectStatistics({ ...project, local: null }, [], true)).toEqual({
      chatCount: null,
      activeChatCount: null,
      lastActivityAt: null,
    });
    expect(resolveGalleryProjectStatistics(project, [], false).chatCount).toBeNull();
    expect(resolveGalleryProjectStatistics(project, [], true).chatCount).toBe(0);
  });
});
