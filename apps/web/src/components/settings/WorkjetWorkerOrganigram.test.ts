import {
  WorkjetComputerId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoLayoutWorkjetWorkerGraph,
  sanitizeWorkjetWorkerGraph,
} from "./WorkjetWorkerOrganigram";

const profile = (id: string): WorkjetWorkerProfile => ({
  id: WorkjetWorkerProfileId.make(id),
  name: id,
  computerId: WorkjetComputerId.make("computer-1"),
  harness: "codex-cli",
  llmRouteId: WorkjetLlmRouteId.make("route-1"),
  modelId: "gpt-5.6-sol",
  reasoning: "high",
  role: "standard",
  capabilityIds: [],
  capabilityBindings: [],
});

describe("WorkjetWorkerOrganigram", () => {
  it("adds missing positions and removes dangling or duplicate dependencies", () => {
    const workers = [profile("lead"), profile("research"), profile("review")];
    const clean = sanitizeWorkjetWorkerGraph(
      {
        positions: [{ workerId: workers[0]!.id, x: 20, y: 30 }],
        dependencies: [
          { fromWorkerId: workers[0]!.id, toWorkerId: workers[1]!.id },
          { fromWorkerId: workers[0]!.id, toWorkerId: workers[1]!.id },
          { fromWorkerId: WorkjetWorkerProfileId.make("missing"), toWorkerId: workers[2]!.id },
        ],
      },
      workers,
    );

    expect(clean.positions).toHaveLength(3);
    expect(clean.positions[0]).toEqual({ workerId: workers[0]!.id, x: 20, y: 30 });
    expect(clean.dependencies).toEqual([
      { fromWorkerId: workers[0]!.id, toWorkerId: workers[1]!.id },
    ]);
  });

  it("lays dependency levels out from left to right", () => {
    const workers = [profile("lead"), profile("research"), profile("review")];
    const graph = autoLayoutWorkjetWorkerGraph(
      {
        positions: [],
        dependencies: [
          { fromWorkerId: workers[0]!.id, toWorkerId: workers[1]!.id },
          { fromWorkerId: workers[1]!.id, toWorkerId: workers[2]!.id },
        ],
      },
      workers,
    );
    const x = (id: string) =>
      graph.positions.find((position) => position.workerId === id)?.x ?? Number.NaN;
    expect(x("lead")).toBeLessThan(x("research"));
    expect(x("research")).toBeLessThan(x("review"));
  });

  it("keeps the default twelve-worker fleet inside a typical settings canvas", () => {
    const workers = Array.from({ length: 12 }, (_, index) => profile(`worker-${String(index)}`));
    const graph = sanitizeWorkjetWorkerGraph({ positions: [], dependencies: [] }, workers);

    expect(Math.max(...graph.positions.map(({ x }) => x + 192))).toBeLessThanOrEqual(712);
    expect(Math.max(...graph.positions.map(({ y }) => y + 76))).toBeLessThanOrEqual(440);
  });
});
