import { describe, expect, it } from "vite-plus/test";
import { projectSupervisorThreadInput } from "./projectSupervisor";

describe("projectSupervisorThreadInput", () => {
  it("builds the same supervisor thread that first open creates", () => {
    const input = projectSupervisorThreadInput({
      threadId: "t-1",
      projectId: "p-1",
      title: "Metric",
      modelSelection: { provider: "claude" },
      createdAt: "2026-10-13T07:00:00.000Z",
    });
    expect(input.title).toBe("Projekt-Supervisor");
    expect(input.workjetConfig.role).toBe("orchestrator");
    expect(input.workjetConfig.team).toEqual({
      role: "supervisor",
      projectId: "p-1",
      threadId: "t-1",
      parentThreadId: null,
      goal: "Coordinate the goals of Metric",
      createdAt: "2026-10-13T07:00:00.000Z",
    });
  });
});
