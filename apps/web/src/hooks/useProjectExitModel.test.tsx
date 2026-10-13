import * as Schema from "effect/Schema";
import { WorkjetExitModelAssessment } from "@workjet/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { exitModelFixture } from "../test/exitModelFixture";
import { exitModelPresentation } from "../projectExitModel";

const scope = {
  mode: "code" as const,
  selectedInstanceId: "managed:selected",
  selectionRevision: 1,
};
const ids = vi.hoisted(() => ({ n: 0 }));
const port = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../activeWorkjetScope", () => ({
  readActiveWorkjetScope: () => scope,
  useActiveWorkjetScope: () => scope,
}));
vi.mock("../workjetProjectRegistry", () => ({
  refreshWorkjetProjectRegistry: vi.fn(),
}));
vi.mock("../lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/utils")>();
  return {
    ...actual,
    newCommandId: () => {
      ids.n += 1;
      return `cmd-${ids.n}`;
    },
  };
});
vi.mock("../workjetProjectControl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workjetProjectControl")>();
  return { ...actual, requestWorkjetProjectControl: port.request };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => {
      const memo = reactHookHarness.useRef<{ callback: T; deps: readonly unknown[] } | null>(null);
      if (
        memo.current === null ||
        memo.current.deps.length !== deps.length ||
        memo.current.deps.some((dep, index) => !Object.is(dep, deps[index]))
      )
        memo.current = { callback, deps };
      return memo.current.callback;
    },
    useEffect: reactHookHarness.useEffect,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { useProjectExitModel } from "./useProjectExitModel";

const decode = Schema.decodeUnknownSync(WorkjetExitModelAssessment);
const proposal = decode({
  ...exitModelFixture,
  status: "blocked",
  result: null,
  scenarios: [],
  diagnostics: [],
  run_id: "run-proposal",
  plan_summary: { ...exitModelFixture.plan_summary!, confirmed: false },
  missing_inputs: ["confirmed_resource_plan"],
  findings: [
    { code: "resource_proposal_requires_confirmation", message: "Vorschlag erfordert Bestätigung" },
  ],
  resource_proposal: {
    hours_per_week: 12,
    monthly_budget_eur: 3_000,
    comparison_mode: "project_specific",
  },
  history: [],
});
const adopted = decode({
  ...exitModelFixture,
  run_id: "run-adopted",
  plan_summary: { ...exitModelFixture.plan_summary!, confirmed: true },
  missing_inputs: [],
  findings: [],
  confirmed_from_run_id: "run-proposal",
  resource_proposal: proposal.resource_proposal,
});

type Sent = {
  readonly action: string;
  readonly commandId: string;
  readonly projectId: string;
  readonly confirmRunId?: string;
  readonly resources?: unknown;
  readonly inputs?: unknown;
  readonly asOf?: unknown;
};

const sent: Sent[] = [];
let mode: "ok" | "hang" | "wrong-command" | "wrong-run" | "timeout" | "reject" = "ok";
let hang: ((value: unknown) => void) | null = null;

function completed(request: Sent, assessment: unknown, commandId = request.commandId) {
  return {
    _tag: "completed" as const,
    response: {
      action: request.action,
      commandId,
      projectId: request.projectId,
      assessment,
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function render() {
  hooks.beginRender();
  return useProjectExitModel("managed:selected", "project-one", null);
}

beforeEach(() => {
  hooks.reset();
  ids.n = 0;
  sent.length = 0;
  mode = "ok";
  hang = null;
  port.request.mockReset().mockImplementation(async (_instance: string, request: Sent) => {
    sent.push(request);
    if (request.action === "project.exit_model.read") return completed(request, proposal);
    if (request.action !== "project.exit_model.submit")
      return { _tag: "failed", code: "unsupported" };
    if (mode === "hang") return new Promise((resolve) => (hang = resolve));
    if (mode === "timeout") return { _tag: "failed", code: "timeout" };
    if (mode === "reject") return { _tag: "failed", code: "invalid_input" };
    if (mode === "wrong-command") return completed(request, adopted, "other-command");
    if (mode === "wrong-run")
      return completed(request, { ...adopted, confirmed_from_run_id: "run-other" });
    return completed(request, adopted);
  });
});

async function readyProposal() {
  render();
  await settle();
  const view = render();
  expect(view.assessment?.run_id).toBe("run-proposal");
  expect(view.assessment?.result).toBeNull();
  return view;
}

describe("one-click exit proposal adoption", () => {
  it("sends exactly the submit command for the run that was just read", async () => {
    await readyProposal();
    expect(await render().confirm()).toBe(true);
    const submits = sent.filter((request) => request.action === "project.exit_model.submit");
    expect(submits).toHaveLength(1);
    expect(Object.keys(submits[0]!).sort()).toEqual([
      "action",
      "commandId",
      "confirmRunId",
      "projectId",
    ]);
    expect(submits[0]).toEqual({
      action: "project.exit_model.submit",
      commandId: submits[0]!.commandId,
      projectId: "project-one",
      confirmRunId: "run-proposal",
    });
    const shown = render();
    expect(shown.pending).toBeNull();
    expect(shown.assessment?.confirmed_from_run_id).toBe("run-proposal");
    expect(shown.assessment?.result?.expected_exit_equity_eur).toBe(800_000);
    expect(exitModelPresentation(shown.assessment, "project-one").value).not.toBe("—");
  });

  it("repeats a timed-out adoption with the same command id", async () => {
    await readyProposal();
    mode = "timeout";
    expect(await render().confirm()).toBe(false);
    mode = "ok";
    expect(await render().confirm()).toBe(true);
    const submits = sent.filter((request) => request.action === "project.exit_model.submit");
    expect(submits).toHaveLength(2);
    expect(submits[0]!.commandId).toBe(submits[1]!.commandId);
    expect(submits[0]!.confirmRunId).toBe("run-proposal");
  });

  it("shows a value only after the correlated response", async () => {
    await readyProposal();
    mode = "hang";
    const pending = render().confirm();
    await Promise.resolve();
    const mid = render();
    expect(mid.pending).toBe("submit");
    expect(mid.assessment?.result ?? null).toBeNull();
    expect(exitModelPresentation(mid.assessment, "project-one").value).toBe("—");
    hang?.(completed(sent.at(-1)!, adopted, "other-command"));
    expect(await pending).toBe(false);
    const wrongCommand = render();
    expect(wrongCommand.error).toBeNull();
    expect(wrongCommand.assessment?.result ?? null).toBeNull();
    expect(exitModelPresentation(wrongCommand.assessment, "project-one").value).toBe("—");
    expect(sent.filter((request) => request.action === "project.exit_model.read")).toHaveLength(1);

    mode = "wrong-run";
    expect(await render().confirm()).toBe(false);
    const wrongRun = render();
    expect(wrongRun.assessment?.result ?? null).toBeNull();
    expect(exitModelPresentation(wrongRun.assessment, "project-one").value).toBe("—");
    expect(sent.filter((request) => request.action === "project.exit_model.read")).toHaveLength(1);

    mode = "ok";
    expect(await render().confirm()).toBe(true);
    const shown = render();
    expect(shown.assessment?.status).toBe("provisional");
    expect(shown.assessment?.plan_summary?.confirmed).toBe(true);
    expect(shown.assessment?.missing_inputs).toEqual([]);
    expect(shown.assessment?.confirmed_from_run_id).toBe("run-proposal");
    expect(exitModelPresentation(shown.assessment, "project-one").value).not.toBe("—");
  });

  it("reads the card again after a rejection and does not keep an error", async () => {
    await readyProposal();
    mode = "reject";
    expect(await render().confirm()).toBe(false);
    expect(sent.map((request) => request.action)).toEqual([
      "project.exit_model.read",
      "project.exit_model.submit",
      "project.exit_model.read",
    ]);
    const view = render();
    expect(view.error).toBeNull();
    expect(view.pending).toBeNull();
    expect(view.assessment?.run_id).toBe("run-proposal");
    expect(exitModelPresentation(view.assessment, "project-one").value).toBe("—");
  });
});
