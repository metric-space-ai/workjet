import { CommandId, EnvironmentId, ProjectId, WorkjetComputerId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { localProjectIsVisible, visibleLocalProjects } from "./localProjectVisibility";
import { buildProjectGallery, visibleGalleryProjects } from "./projectOverview";
import type { BusinessOsCodeScopeSnapshot } from "./businessOsCodeScope";
const primary = EnvironmentId.make("local-primary");
const remote = EnvironmentId.make("remote-computer");
const scope: BusinessOsCodeScopeSnapshot = {
  phase: "blocked",
  presentationInstanceId: "welsch",
  businessOsInstanceId: null,
  environmentIds: new Set(),
  blocker: "authority-unavailable",
};
const context = { scope, selectedInstanceId: "welsch", primaryEnvironmentId: primary };
describe("local logical project visibility before computer assignment", () => {
  it("keeps the saved current-tenant project and retained supervisor reachable", () => {
    expect(
      localProjectIsVisible(
        { environmentId: primary, ctoxRegistration: { instanceId: "welsch" } },
        context,
      ),
    ).toBe(true);
  });
  it("does not expose another tenant, a legacy local project, or an unassigned remote computer", () => {
    expect(
      localProjectIsVisible(
        { environmentId: primary, ctoxRegistration: { instanceId: "other" } },
        context,
      ),
    ).toBe(false);
    expect(localProjectIsVisible({ environmentId: primary }, context)).toBe(false);
    expect(
      localProjectIsVisible(
        { environmentId: remote, ctoxRegistration: { instanceId: "welsch" } },
        context,
      ),
    ).toBe(false);
  });
  it("hides the project after switching tenant or clearing the selection", () => {
    const project = { environmentId: primary, ctoxRegistration: { instanceId: "welsch" } };
    expect(localProjectIsVisible(project, { ...context, selectedInstanceId: "other" })).toBe(false);
    expect(localProjectIsVisible(project, { ...context, selectedInstanceId: null })).toBe(false);
    expect(localProjectIsVisible(project, { ...context, primaryEnvironmentId: null })).toBe(false);
  });
});

describe("retained local working-copy metadata while authority reconnects", () => {
  const physical = {
    id: ProjectId.make("retained"),
    environmentId: primary,
    title: "Retained local history",
    workspaceRoot: "/work/project",
    updatedAt: "2026-10-07T00:00:00Z",
    ctoxRegistration: null,
    overview: {
      archived: true,
      websiteUrl: null,
      slots: [null, null, null] as [null, null, null],
    },
  };
  const computer = {
    id: WorkjetComputerId.make("local-computer"),
    environmentId: primary,
    label: "Local",
    presentationKind: "local" as const,
    harnesses: [],
  };
  const native = {
    id: ProjectId.make("canonical"),
    title: "Canonical project",
    workingCopies: [
      {
        id: "copy",
        computerId: computer.id,
        path: physical.workspaceRoot,
        status: "active" as const,
      },
    ],
  };
  it("keeps a saved archive in the gallery through its unique local working-copy identity", () => {
    const projects = visibleLocalProjects([physical], context, [native], [computer]);
    const cards = buildProjectGallery({
      projects,
      nativeProjects: [native],
      instanceId: context.selectedInstanceId,
      primaryEnvironmentId: primary,
      computers: [computer],
    });
    expect(projects).toEqual([physical]);
    expect(cards[0]?.local).toBe(physical);
    expect(visibleGalleryProjects(cards)).toEqual([]);
    expect(visibleGalleryProjects(cards, true).map((card) => card.id)).toEqual(["canonical"]);
    expect(visibleGalleryProjects(cards, true)[0]?.local?.overview?.slots).toHaveLength(3);
  });
  it("shows the same retained history after a saved restore", () => {
    const restored = { ...physical, overview: { ...physical.overview, archived: false } };
    const projects = visibleLocalProjects([restored], context, [native], [computer]);
    const cards = buildProjectGallery({
      projects,
      nativeProjects: [native],
      instanceId: context.selectedInstanceId,
      primaryEnvironmentId: primary,
      computers: [computer],
    });
    expect(visibleGalleryProjects(cards)[0]?.local).toBe(restored);
    expect(visibleGalleryProjects(cards, true)).toEqual([]);
  });
  it("does not reveal a remote history from a matching working copy", () => {
    expect(
      visibleLocalProjects(
        [{ ...physical, environmentId: remote }],
        context,
        [native],
        [{ ...computer, environmentId: remote }],
      ),
    ).toEqual([]);
  });
  it("rejects missing, ambiguous, inactive and wrong-computer working-copy proofs", () => {
    expect(visibleLocalProjects([physical], context, [], [computer])).toEqual([]);
    expect(
      visibleLocalProjects(
        [physical],
        context,
        [native, { ...native, id: ProjectId.make("other") }],
        [computer],
      ),
    ).toEqual([]);
    expect(
      visibleLocalProjects(
        [physical],
        context,
        [
          {
            ...native,
            workingCopies: [{ ...native.workingCopies[0]!, status: "detached" as const }],
          },
        ],
        [computer],
      ),
    ).toEqual([]);
    expect(
      visibleLocalProjects(
        [physical],
        context,
        [native],
        [{ ...computer, id: WorkjetComputerId.make("other") }],
      ),
    ).toEqual([]);
  });
  it("keeps foreign registration and cleared selection closed", () => {
    expect(
      visibleLocalProjects(
        [
          {
            ...physical,
            ctoxRegistration: {
              instanceId: "other",
              commandId: CommandId.make("foreign"),
              status: "confirmed" as const,
            },
          },
        ],
        context,
        [native],
        [computer],
      ),
    ).toEqual([]);
    expect(
      visibleLocalProjects(
        [physical],
        { ...context, selectedInstanceId: null },
        [native],
        [computer],
      ),
    ).toEqual([]);
    expect(
      visibleLocalProjects(
        [physical],
        { ...context, primaryEnvironmentId: null },
        [native],
        [computer],
      ),
    ).toEqual([]);
  });
});
