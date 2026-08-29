import { ProjectId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  __resetWorkjetProjectRegistryForTests,
  findWorkjetProjectByWorkingCopy,
  loadingWorkjetProjectRegistry,
  mergeWorkjetProjectProjection,
  readWorkjetProjectRegistry,
  recordWorkjetProjectProjection,
} from "./workjetProjectRegistry";

afterEach(() => __resetWorkjetProjectRegistryForTests());

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
  it("starts every new instance with an empty loading projection", () => {
    expect(loadingWorkjetProjectRegistry("managed:welsch")).toEqual({
      presentationInstanceId: "managed:welsch",
      phase: "loading",
      projects: [],
      selectedProjectId: null,
    });
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
});
