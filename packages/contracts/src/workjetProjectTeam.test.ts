import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { WorkjetProjectTeamMember, WorkjetTeamReview } from "./workjetProjectTeam.ts";

const member = {
  projectId: "project-one",
  threadId: "thread-one",
  goal: "Deliver the project and retain ownership across worker PRs",
  createdAt: "2026-09-19T10:00:00.000Z",
};
const decodeMember = Schema.decodeUnknownSync(WorkjetProjectTeamMember);
const decodeReview = Schema.decodeUnknownSync(WorkjetTeamReview);

describe("project team contracts", () => {
  it("requires explicit parent ownership for specialists and workers", () => {
    expect(() => decodeMember({ ...member, role: "specialist", domain: "desktop" })).toThrow();
    expect(() => decodeMember({ ...member, role: "worker", packageId: "package-one" })).toThrow();
    expect(decodeMember({ ...member, role: "supervisor", parentThreadId: null }).role).toBe(
      "supervisor",
    );
    expect(() =>
      decodeMember({ ...member, role: "supervisor", parentThreadId: "parent" }),
    ).toThrow();
  });

  it("keeps parent review and worker delivery separately attributable", () => {
    const review = {
      reviewId: "review-one",
      packageId: "package-one",
      reviewerThreadId: "reviewer",
      subjectThreadId: "worker",
      execution: {
        providerInstanceId: "codex",
        model: "actual-model",
        harness: "codex",
        harnessVersion: null,
      },
      taskType: "backend",
      difficulty: "standard",
      phase: "first-delivery",
      score: 0,
      practice: "Missing restart recovery made the delivery unusable",
      evidenceRef: "pull-request:1/review:1",
      recordedAt: member.createdAt,
    };
    expect(decodeReview(review).score).toBe(0);
    expect(decodeReview({ ...review, phase: "handover" }).phase).toBe("handover");
    expect(() => decodeReview({ ...review, phase: "quota" })).toThrow();
    expect(() => decodeReview({ ...review, score: 11 })).toThrow();
    expect(() => decodeReview({ ...review, score: 5.5 })).toThrow();
    expect(() => decodeReview({ ...review, execution: { model: "guessed" } })).toThrow();
  });
});
