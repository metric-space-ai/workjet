import { ProjectId, ThreadId, type WorkjetProjectTeamMember } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compileCapabilityPrompt } from "./prompt.ts";

const common = {
  projectId: ProjectId.make("molecularity"),
  threadId: ThreadId.make("member"),
  goal: "Deliver the approved weekly outcome.",
  createdAt: "2026-10-09T21:00:00.000Z",
};
const teams: readonly WorkjetProjectTeamMember[] = [
  { ...common, role: "supervisor", parentThreadId: null },
  { ...common, role: "specialist", parentThreadId: ThreadId.make("supervisor"), domain: "harness" },
  { ...common, role: "worker", parentThreadId: ThreadId.make("parent"), packageId: "package" },
];
const compile = (team: WorkjetProjectTeamMember) =>
  compileCapabilityPrompt({
    role: "orchestrator",
    team,
    managedInstructions: "Owner policy.",
    manifests: [],
  });

describe("project team role prompts", () => {
  it.each(teams)("uses the project $role instead of the legacy settings role", (team) => {
    const prompt = compile(team);
    expect(prompt).not.toContain("## Workjet Role: Orchestrator");
    expect(prompt).toContain(common.goal);
    expect(prompt).toContain("Project: molecularity. Thread: member.");
    expect(prompt.indexOf("## Workjet Role:")).toBeLessThan(
      prompt.indexOf("## Managed Instructions"),
    );
  });

  it("keeps the supervisor permanent and gives implementation to its workers", () => {
    const prompt = compile(teams[0]!);
    expect(prompt).toContain("Do not implement product code yourself");
    expect(prompt).toContain("default every 30 minutes");
    expect(prompt).toContain("confirmed to-do list of the last regular meeting");
    expect(prompt).not.toContain("Your durable parent thread");
    expect(prompt).toContain("action project");
    expect(prompt).toContain("Do not maintain your own mini-kanban");
    expect(prompt).toContain("Take times, counts and status from measurements or logs");
    expect(prompt).toContain("self-contained order");
    expect(prompt).toContain("Verify the installed/deployed result afterwards");
    expect(prompt).not.toContain("action update");
    expect(prompt).not.toContain("Stop after submission");
  });

  it("keeps parents active across turns and reports only verified outcomes or concrete blockers", () => {
    const prompt = compile(teams[1]!);
    expect(prompt).toContain("Your durable parent thread is supervisor.");
    expect(prompt).toContain("Perform substantive work yourself");
    expect(prompt).toContain("before any other work");
    expect(prompt).toContain("workjet_worker_kanban with action update exactly once");
    expect(prompt).toContain("as a slide-engine document");
    expect(prompt).toContain("owner, evidence, commit/PR link and next trigger");
    expect(prompt).toContain("registry and open PRs");
    expect(prompt).toContain("Compaction is not completion");
    expect(prompt).toContain(
      "A completed turn, a partial result, a queued build or a pull request does not by itself complete the goal",
    );
    expect(prompt).toContain("respect an explicit Owner stop");
    expect(prompt).toContain("Do not send routine progress or acknowledgements");
    expect(prompt).not.toContain("Stop after submission");
  });

  it("ends one-shot workers at PR submission rather than waiting for merge", () => {
    const prompt = compile(teams[2]!);
    expect(prompt).toContain("Your durable parent thread is parent.");
    expect(prompt).toContain("Do not commission or spawn other workers");
    expect(prompt).toContain("Open exactly one pull request");
    expect(prompt).toContain("Stop after submission");
    expect(prompt).toContain("Workjet owns automatic archival");
    expect(prompt).not.toContain("workjet_worker_kanban");
    expect(prompt).not.toMatch(/kanban|goal-loop/i);
    expect(prompt).toContain("Do not merge your own pull request");
    expect(prompt).toContain("do not wait for the pull request to be merged or perform post-submission rework");
    expect(prompt).not.toContain("keep all rework in that same pull request");
  });
});
