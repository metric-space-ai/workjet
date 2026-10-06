import { describe, expect, it } from "vite-plus/test";
import {
  compareTeamCandidates,
  drawTeamCandidate,
  teamExecutionCandidateKey,
} from "./ProjectTeamLearning.ts";

describe("project team empirical selection", () => {
  it("keeps execution identities with separators and missing versions in distinct pools", () => {
    const execution = {
      providerInstanceId: "provider/one",
      model: "model",
      harness: "harness",
      harnessVersion: null,
    };
    expect(teamExecutionCandidateKey(execution)).toBe("provider%2Fone/model/harness/");
    expect(teamExecutionCandidateKey(execution)).not.toBe(
      teamExecutionCandidateKey({
        ...execution,
        providerInstanceId: "provider",
        model: "one/model",
      }),
    );
    expect(teamExecutionCandidateKey(execution)).not.toBe(
      teamExecutionCandidateKey({ ...execution, harnessVersion: "unknown" }),
    );
  });
  it("explores uniformly, uses 50/50 only with an available winner, and keeps no-candidate work pending", () => {
    expect(
      drawTeamCandidate({ available: ["a", "b", "c"], winner: null, draw: 0.4 })?.candidate,
    ).toBe("b");
    expect(
      drawTeamCandidate({ available: ["a", "b", "c"], winner: "b", draw: 0.5 })?.probabilities,
    ).toEqual([
      { candidate: "a", probability: 0.25 },
      { candidate: "b", probability: 0.5 },
      { candidate: "c", probability: 0.25 },
    ]);
    expect(drawTeamCandidate({ available: ["a", "c"], winner: "b", draw: 0.6 })?.candidate).toBe(
      "c",
    );
    expect(drawTeamCandidate({ available: [], winner: null, draw: 0.1 })).toBeNull();
    expect(() => drawTeamCandidate({ available: ["a"], winner: null, draw: 1 })).toThrow();
  });
  it("does not treat outages, duplicate delivery or incomparable work as capability evidence", () => {
    const observation = {
      selectionId: "one",
      candidate: "a",
      taskType: "backend",
      difficulty: "standard",
      reasoning: "high",
      randomized: true,
      firstScore: 0,
      cause: "quota" as const,
    };
    const result = compareTeamCandidates({
      candidates: ["a", "b"],
      taskType: "backend",
      difficulty: "standard",
      reasoning: "high",
      observations: [
        observation,
        observation,
        { ...observation, selectionId: "two", difficulty: "hard" },
        { ...observation, selectionId: "three", cause: "unknown" as const },
      ],
    });
    expect(result.winner).toBeNull();
    expect(result.rows[0]).toMatchObject({
      assigned: 2,
      scored: 0,
      unassessed: 2,
      mean: null,
      low: 0,
      high: 10,
    });
  });
  it("requires separated confidence intervals before declaring a winner", () => {
    const observations = ["a", "b"].flatMap((candidate) =>
      Array.from({ length: 1000 }, (_, n) => ({
        selectionId: `${candidate}-${n}`,
        candidate,
        taskType: "backend",
        difficulty: "standard",
        reasoning: "high",
        randomized: true,
        firstScore: candidate === "a" ? 10 : 0,
        cause: "model" as const,
      })),
    );
    expect(
      compareTeamCandidates({
        candidates: ["a", "b"],
        taskType: "backend",
        difficulty: "standard",
        reasoning: "high",
        observations,
      }).winner,
    ).toBe("a");
  });
});
