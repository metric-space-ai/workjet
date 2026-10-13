import {
  WorkjetComputerId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type WorkjetWorkerProfile,
} from "@workjet/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  autoLayoutWorkjetWorkerGraph,
  sanitizeWorkjetWorkerGraph,
  WorkjetWorkerOrganigram,
  organigramEditorPosition,
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

  it("renders a German toolbar on the page itself, without any popup", () => {
    const workers = [profile("lead")];
    const markup = renderToStaticMarkup(
      createElement(WorkjetWorkerOrganigram, {
        workers,
        graph: { positions: [], dependencies: [] },
        onChange: () => undefined,
        onAddWorker: () => undefined,
        onEditWorker: () => undefined,
        onDeleteWorker: () => undefined,
      }),
    );
    expect(markup).toContain("Anordnen");
    expect(markup).toContain('aria-label="Luma-Organigramm"');
    expect(markup).toContain('aria-label="Unter-Luma für lead"');
    expect(markup).not.toContain("Arrange");
    expect(markup).not.toContain('role="dialog"');
  });
});

describe("organigramEditorPosition", () => {
  it("opens directly below the clicked node", () => {
    expect(organigramEditorPosition({ x: 120, y: 40 }, 1000)).toEqual({ left: 120, top: 130 });
  });
  it("stays inside the canvas width", () => {
    expect(organigramEditorPosition({ x: 700, y: 0 }, 800).left).toBe(352);
  });
  it("uses the top left corner for a new top-level Luma", () => {
    expect(organigramEditorPosition(null, 800)).toEqual({ left: 8, top: 8 });
  });
});
