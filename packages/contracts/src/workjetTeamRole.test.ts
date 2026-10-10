import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  canCoordinateWorkjet,
  normalizeWorkjetThreadConfig,
  workjetExecutionRole,
  type WorkjetThreadConfig,
} from "./workjet.ts";

const common = {
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  goal: "Deliver the approved outcome.",
  createdAt: "2026-10-09T21:00:00.000Z",
};
describe("team-derived coordination and legacy migration", () => {
  for (const role of ["supervisor", "specialist"] as const) {
    const team =
      role === "supervisor"
        ? { ...common, role, parentThreadId: null }
        : {
            ...common,
            role,
            parentThreadId: ThreadId.make("supervisor"),
            domain: "implementation",
          };
    it(`gives ${role} coordination independently of the old Luma switch`, () => {
      for (const legacyRole of ["standard", "orchestrator"] as const) {
        const config = { ...DEFAULT_WORKJET_THREAD_CONFIG, role: legacyRole, team };
        expect(canCoordinateWorkjet(config)).toBe(true);
        expect(workjetExecutionRole(config)).toBe("orchestrator");
        const migrated = normalizeWorkjetThreadConfig(config);
        expect(migrated).toEqual({ ...config, role: "standard" });
        expect(migrated.team).toEqual(team);
        expect(workjetExecutionRole(migrated)).toBe("orchestrator");
      }
    });
  }
  it("cannot grant coordination to a one-shot or a roleless chat through an old setting", () => {
    const worker = {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      role: "orchestrator",
      team: {
        ...common,
        role: "worker",
        parentThreadId: ThreadId.make("supervisor"),
        packageId: "package",
      },
    } as WorkjetThreadConfig;
    expect(canCoordinateWorkjet(worker)).toBe(false);
    expect(workjetExecutionRole(worker)).toBe("worker");
    expect(workjetExecutionRole({ ...DEFAULT_WORKJET_THREAD_CONFIG, role: "orchestrator" })).toBe(
      "standard",
    );
    expect(canCoordinateWorkjet(DEFAULT_WORKJET_THREAD_CONFIG)).toBe(false);
  });
});
