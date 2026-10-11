import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type CtoxWorkjetProjectProjection,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  tokenBudgetCalendarUpdates,
  deferTokenBudgetCalendarSource,
} from "./projectTokenBudgetSource";
import { projectTokenCycle } from "@workjet/shared/projectTokenBudget";
import type { GalleryLocalProject } from "./projectOverview";

const meeting = { weekday: 3, time: "13:00", timezone: "Europe/Berlin" };
const project: GalleryLocalProject = {
  id: ProjectId.make("fixture"),
  environmentId: EnvironmentId.make("isolated"),
  title: "Fixture",
  updatedAt: "2026-10-11T10:00:00Z",
  faviconPath: null,
  ctoxRegistration: {
    instanceId: "fixture-instance",
    commandId: CommandId.make("register"),
    status: "confirmed",
  },
  overview: {
    websiteUrl: null,
    slots: [null, null, null],
    tokenBudget: { limitBillions: 2.3, revision: 4, jourFixe: meeting },
  },
};
const source: CtoxWorkjetProjectProjection = {
  id: project.id,
  title: project.title,
  workingCopies: [],
  jourFixe: meeting,
};
const updates = (native: CtoxWorkjetProjectProjection) =>
  tokenBudgetCalendarUpdates({
    instanceId: "fixture-instance",
    projects: [project],
    nativeProjects: [native],
    computers: [],
  });

describe("token budget calendar source", () => {
  it("does not race the editor's budget write when its calendar source is echoed first", () => {
    const resume = deferTokenBudgetCalendarSource(project.id);
    try {
      expect(updates({ ...source, jourFixe: null })).toEqual([]);
    } finally {
      resume();
    }
    expect(updates({ ...source, jourFixe: null })).toHaveLength(1);
  });
  it("follows a synchronized meeting change without an editor event and preserves the budget revision", () => {
    const next = { weekday: 5, time: "14:00", timezone: "Europe/Berlin" };
    const update = updates({ ...source, jourFixe: next })[0]!;
    expect(update.input.expectedTokenBudgetRevision).toBe(4);
    expect(update.input.overview.tokenBudget).toEqual({
      limitBillions: 2.3,
      revision: 4,
      jourFixe: next,
    });
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(projectTokenCycle(now, next)).not.toEqual(projectTokenCycle(now, meeting));
  });
  it("follows explicit removal into calendar-week cycles but ignores unknown or unchanged sources", () => {
    expect(
      updates({ ...source, jourFixe: null })[0]!.input.overview.tokenBudget.jourFixe,
    ).toBeNull();
    expect(projectTokenCycle(Date.parse("2026-10-15T12:00:00Z"), null).start).toBe(
      "2026-10-11T22:00:00.000Z",
    );
    expect(updates(source)).toEqual([]);
    const { jourFixe: _meeting, ...unknown } = source;
    expect(updates(unknown)).toEqual([]);
    expect(updates({ ...source, id: ProjectId.make("foreign"), jourFixe: null })).toEqual([]);
  });
});
