import { describe, expect, it } from "vite-plus/test";
import {
  clearProjectInit,
  markProjectInitPending,
  pendingProjectInit,
  presentProjectInitStep,
  requestProjectInit,
} from "./projectInit";
import { resolveProjectInitSteps } from "./components/ProjectInitProgress";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

const PROJECT = "7f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";

describe("project init", () => {
  it("keeps one stable operation per project and expires after a day", () => {
    const storage = memoryStorage();
    const first = markProjectInitPending("inst", PROJECT, storage, 1_000);
    expect(markProjectInitPending("inst", PROJECT, storage, 2_000)).toBe(first);
    expect(pendingProjectInit("inst", PROJECT, storage, 3_000)).toBe(first);
    expect(pendingProjectInit("other", PROJECT, storage, 3_000)).toBeNull();
    expect(pendingProjectInit("inst", PROJECT, storage, 1_000 + 25 * 3600_000)).toBeNull();
    clearProjectInit("inst", PROJECT, storage, 3_000);
    expect(pendingProjectInit("inst", PROJECT, storage, 3_000)).toBeNull();
  });

  it("names blocked states plainly in both languages", () => {
    const step = { id: "supervisor", state: "failed", detail: "no model provider account" };
    expect(presentProjectInitStep(step, false)).toEqual({
      label: "Supervisor",
      tone: "failed",
      note: "Modell-Konto fehlt",
    });
    expect(presentProjectInitStep(step, true).note).toBe("Model account missing");
    expect(
      presentProjectInitStep(
        { id: "kpis", state: "blocked", detail: "supervisor_not_bound" },
        false,
      ).note,
    ).toBe("Supervisor noch nicht eingerichtet");
    expect(presentProjectInitStep({ id: "regeltermin", state: "done", detail: "" }, true)).toEqual({
      label: "Regular meeting",
      tone: "done",
      note: null,
    });
  });

  it("lets native KPI and exit state override queued steps", () => {
    const steps = [
      { id: "kpis", state: "queued", detail: "supervisor" },
      { id: "exit", state: "queued", detail: "research turn admitted" },
    ];
    expect(resolveProjectInitSteps(steps, { kpiCount: 3, exitStatus: "blocked" })).toEqual([
      { id: "kpis", state: "done", detail: "supervisor" },
      { id: "exit", state: "blocked", detail: "exit_inputs_missing" },
    ]);
    expect(resolveProjectInitSteps(steps, { kpiCount: 0, exitStatus: "ready" })[1]!.state).toBe(
      "done",
    );
  });

  it("re-calls with the same operation and rejects an uncorrelated receipt", async () => {
    const seen: unknown[] = [];
    const port = async (_instance: string, request: { commandId: string; operationId: string }) => {
      seen.push(request.operationId);
      return {
        _tag: "completed" as const,
        response: {
          action: "project.init" as const,
          commandId: request.commandId,
          projectId: PROJECT,
          operationId: request.operationId,
          steps: [{ id: "regeltermin", state: "done", detail: "created" }],
        },
      };
    };
    const result = await requestProjectInit("inst", PROJECT, "op", port as never);
    expect(result).toEqual({
      _tag: "completed",
      steps: [{ id: "regeltermin", state: "done", detail: "created" }],
    });
    await requestProjectInit("inst", PROJECT, "op", port as never);
    expect(seen).toEqual(["op", "op"]);
  });
});

it("rejects a receipt for another project", async () => {
  const port = async (_i: string, request: { commandId: string; operationId: string }) => ({
    _tag: "completed" as const,
    response: {
      action: "project.init" as const,
      commandId: request.commandId,
      projectId: "foreign",
      operationId: request.operationId,
      steps: [],
    },
  });
  expect(await requestProjectInit("inst", PROJECT, "op", port as never)).toEqual({
    _tag: "failed",
    code: "guest_failed",
  });
});
