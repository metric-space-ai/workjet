import {
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type WorkjetComputer,
} from "@workjet/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createProjectRegistryRefresh } from "./projectRegistryRefresh";
import {
  __resetWorkjetProjectRegistryForTests,
  applyWorkjetProjectRegistryResult,
  findWorkjetProjectByWorkingCopy,
  loadingWorkjetProjectRegistry,
  mergeWorkjetProjectProjection,
  readWorkjetProjectRegistry,
  recordWorkjetProjectProjection,
  resolveLocalWorkjetComputer,
  resolveLocalWorkjetWorkingCopy,
  resolveSelectedWorkjetProjectId,
  selectWorkjetProject,
} from "./workjetProjectRegistry";

afterEach(() => {
  __resetWorkjetProjectRegistryForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
const computer = (id: string, environmentId: EnvironmentId): WorkjetComputer => ({
  id: WorkjetComputerId.make(id),
  label: id,
  environmentId,
  presentationKind: environmentId === localEnvironmentId ? "local" : "ssh",
  harnesses: [],
});

const project = {
  id: ProjectId.make("11111111-1111-4111-8111-111111111111"),
  title: "greppy",
  workingCopies: [
    {
      id: "copy:greppy",
      computerId: "computer:mac",
      path: "/workspace/greppy/",
      status: "active" as const,
    },
  ],
};

describe("Workjet project registry", () => {
  it("recovers a failed registry without a click, retains history and updates the saved timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T13:00:00Z"));
    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    const response = {
      action: "project.list" as const,
      projects: [project],
      count: 1,
      truncated: false as const,
    };
    applyWorkjetProjectRegistryResult("managed:welsch", { _tag: "completed", response });
    const confirmedAt = readWorkjetProjectRegistry("managed:welsch").lastUpdatedAt;
    let online = false;
    const controller = createProjectRegistryRefresh(async () => {
      applyWorkjetProjectRegistryResult(
        "managed:welsch",
        online
          ? {
              _tag: "completed",
              response: { ...response, projects: [{ ...project, title: "Updated" }] },
            }
          : {
              _tag: "failed",
              code: "guest_failed",
              preparation: { stage: "navigation_commit", reason: "did_fail_load", errorCode: -102 },
            },
      );
      return online;
    });
    await controller.refresh();
    expect(readWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      projects: [project],
      refreshFailed: true,
      lastUpdatedAt: confirmedAt,
    });
    online = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readWorkjetProjectRegistry("managed:welsch").projects[0]?.title).toBe("Updated");
    expect(readWorkjetProjectRegistry("managed:welsch").refreshFailed).toBeUndefined();
    expect(readWorkjetProjectRegistry("managed:welsch").lastUpdatedAt).toBe(confirmedAt! + 1_000);
    controller.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps saved selected history usable on failure and restores it after reopen", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    recordWorkjetProjectProjection("managed:welsch", project, { select: true });
    applyWorkjetProjectRegistryResult("managed:welsch", { _tag: "failed", code: "timeout" });
    expect(readWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      phase: "ready",
      refreshFailed: true,
      projects: [project],
      selectedProjectId: project.id,
    });
    __resetWorkjetProjectRegistryForTests();
    expect(loadingWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      phase: "ready",
      projects: [project],
      selectedProjectId: project.id,
    });
  });

  it("blocks an uncached failure, then clears that notice after a successful list", () => {
    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    applyWorkjetProjectRegistryResult("managed:welsch", { _tag: "failed", code: "not_active" });
    expect(readWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      phase: "blocked",
      refreshFailed: true,
      projects: [],
    });
    applyWorkjetProjectRegistryResult("managed:welsch", {
      _tag: "completed",
      response: { action: "project.list", projects: [project], count: 1, truncated: false },
    });
    expect(readWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      phase: "ready",
      projects: [project],
    });
    expect(readWorkjetProjectRegistry("managed:welsch").refreshFailed).toBeUndefined();
  });

  it("honors a confirmed empty list and ignores late results from another instance", () => {
    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    recordWorkjetProjectProjection("managed:welsch", project, { select: true });
    applyWorkjetProjectRegistryResult("managed:other", { _tag: "failed", code: "timeout" });
    expect(readWorkjetProjectRegistry("managed:welsch").refreshFailed).toBeUndefined();
    expect(readWorkjetProjectRegistry("managed:welsch").selectedProjectId).toBe(project.id);
    applyWorkjetProjectRegistryResult("managed:welsch", {
      _tag: "completed",
      response: { action: "project.list", projects: [], count: 0, truncated: false },
    });
    expect(readWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      phase: "ready",
      projects: [],
      selectedProjectId: null,
    });
  });

  it("keeps the overview selected after clearing a project and reopening", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    recordWorkjetProjectProjection("managed:welsch", project, { select: true });
    expect(selectWorkjetProject("managed:welsch", null)).toBe(true);
    __resetWorkjetProjectRegistryForTests();
    expect(loadingWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      phase: "ready",
      projects: [project],
      selectedProjectId: null,
    });
  });

  it("cannot clear or select a project in another instance", () => {
    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    recordWorkjetProjectProjection("managed:welsch", project, { select: true });
    expect(selectWorkjetProject("managed:other", null)).toBe(false);
    expect(selectWorkjetProject("managed:other", project.id)).toBe(false);
    expect(readWorkjetProjectRegistry("managed:welsch").selectedProjectId).toBe(project.id);
  });

  it("does not replace the overview or a removed selection with the first refreshed project", () => {
    expect(resolveSelectedWorkjetProjectId([project], null)).toBeNull();
    expect(
      resolveSelectedWorkjetProjectId([project], "22222222-2222-4222-8222-222222222222"),
    ).toBeNull();
    expect(resolveSelectedWorkjetProjectId([project], project.id)).toBe(project.id);
  });

  it("returns to the overview when a saved selected project no longer exists", () => {
    vi.stubGlobal("localStorage", {
      getItem: () =>
        JSON.stringify({
          version: 1,
          projects: [project],
          selectedProjectId: "22222222-2222-4222-8222-222222222222",
        }),
      setItem: () => undefined,
    });
    expect(loadingWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      projects: [project],
      selectedProjectId: null,
    });
  });

  it("starts every new instance with an empty loading projection", () => {
    expect(loadingWorkjetProjectRegistry("managed:welsch")).toEqual({
      presentationInstanceId: "managed:welsch",
      phase: "loading",
      projects: [],
      selectedProjectId: null,
    });
  });

  it("returns a referentially stable loading snapshot for React external-store reads", () => {
    expect(loadingWorkjetProjectRegistry("managed:welsch")).toBe(
      loadingWorkjetProjectRegistry("managed:welsch"),
    );
    expect(loadingWorkjetProjectRegistry(null)).toBe(loadingWorkjetProjectRegistry(null));
  });

  it("rejects a late projection from a different instance", () => {
    const current = loadingWorkjetProjectRegistry("managed:other");
    expect(mergeWorkjetProjectProjection(current, "managed:welsch", project)).toBe(current);
  });

  it("merges the exact active-instance projection", () => {
    const current = loadingWorkjetProjectRegistry("managed:welsch");
    expect(mergeWorkjetProjectProjection(current, "managed:welsch", project)).toEqual({
      presentationInstanceId: "managed:welsch",
      phase: "ready",
      projects: [project],
      selectedProjectId: null,
    });
  });

  it("matches a working copy by exact computer and normalized path", () => {
    expect(findWorkjetProjectByWorkingCopy([project], "computer:mac", "/workspace/greppy")).toBe(
      project,
    );
    expect(
      findWorkjetProjectByWorkingCopy([project], "computer:other", "/workspace/greppy"),
    ).toBeUndefined();
  });

  it("resolves a local working-copy computer without a draft environment", () => {
    const localComputer = computer("computer-local", localEnvironmentId);
    const remoteComputer = computer("computer-remote", remoteEnvironmentId);

    expect(
      resolveLocalWorkjetWorkingCopy({
        computers: [remoteComputer, localComputer],
        resolvedComputer: null,
        localEnvironmentId,
        path: "/workspace/greppy",
      }),
    ).toEqual({
      computerId: localComputer.id,
      path: "/workspace/greppy",
    });
  });

  it("uses an F2-resolved computer only when it belongs to the local environment", () => {
    const firstLocalComputer = computer("computer-local-first", localEnvironmentId);
    const resolvedLocalComputer = computer("computer-local-resolved", localEnvironmentId);
    const resolvedRemoteComputer = computer("computer-remote-resolved", remoteEnvironmentId);

    expect(
      resolveLocalWorkjetComputer({
        computers: [firstLocalComputer, resolvedLocalComputer],
        resolvedComputer: resolvedLocalComputer,
        localEnvironmentId,
      }),
    ).toBe(resolvedLocalComputer);
    expect(
      resolveLocalWorkjetComputer({
        computers: [resolvedRemoteComputer, firstLocalComputer],
        resolvedComputer: resolvedRemoteComputer,
        localEnvironmentId,
      }),
    ).toBe(firstLocalComputer);
  });

  it("returns no working-copy computer when no local computer is registered", () => {
    const remoteComputer = computer("computer-remote", remoteEnvironmentId);

    expect(
      resolveLocalWorkjetComputer({
        computers: [remoteComputer],
        resolvedComputer: remoteComputer,
        localEnvironmentId,
      }),
    ).toBeNull();
  });

  it("publishes an authoritative project only for the currently active instance", () => {
    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    expect(recordWorkjetProjectProjection("managed:welsch", project, { select: true })).toBe(true);
    expect(readWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      presentationInstanceId: "managed:welsch",
      phase: "ready",
      projects: [project],
      selectedProjectId: project.id,
    });
    expect(recordWorkjetProjectProjection("managed:other", project)).toBe(false);
  });

  it("restores the last confirmed projection before the embedded Business OS view is active", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    __resetWorkjetProjectRegistryForTests(loadingWorkjetProjectRegistry("managed:welsch"));
    expect(recordWorkjetProjectProjection("managed:welsch", project, { select: true })).toBe(true);

    __resetWorkjetProjectRegistryForTests();
    expect(loadingWorkjetProjectRegistry("managed:welsch")).toMatchObject({
      presentationInstanceId: "managed:welsch",
      phase: "ready",
      projects: [project],
      selectedProjectId: project.id,
    });
  });
});
