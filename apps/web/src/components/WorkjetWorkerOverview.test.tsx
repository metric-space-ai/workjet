import type { EnvironmentId, ThreadId, WorkjetThreadConfig } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ReactElement } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  WorkjetWorkerOverview,
  buildWorkerOverviewRows,
  resolveWorkerTurnState,
} from "./WorkjetWorkerOverview";

const envA = "env-a" as EnvironmentId;

function orchestratorConfig(): WorkjetThreadConfig {
  return {
    schemaVersion: 1,
    role: "orchestrator",
    parent: null,
    managedInstructions: "",
    enabledCapabilityIds: [],
  };
}

function standardConfig(): WorkjetThreadConfig {
  return {
    schemaVersion: 1,
    role: "standard",
    parent: null,
    managedInstructions: "",
    enabledCapabilityIds: [],
  };
}

function workerConfig(parentThreadId: ThreadId): WorkjetThreadConfig {
  return {
    schemaVersion: 1,
    role: "worker",
    parent: { environmentId: envA, threadId: parentThreadId },
    managedInstructions: "",
    enabledCapabilityIds: [],
  };
}

// The overview only reads a subset of the shell; build a minimal shape and
// widen it to EnvironmentThreadShell for the component's prop type.
function makeShell(overrides: {
  id: string;
  title: string;
  workjetConfig: WorkjetThreadConfig;
  model?: string;
  providerName?: string | null;
  latestTurnState?: "running" | "interrupted" | "completed" | "error" | null;
  sessionStatus?: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
}): EnvironmentThreadShell {
  const shell = {
    id: overrides.id as ThreadId,
    environmentId: envA,
    title: overrides.title,
    modelSelection: { instanceId: "openai-1", model: overrides.model ?? "gpt-5.6" },
    workjetConfig: overrides.workjetConfig,
    latestTurn:
      overrides.latestTurnState == null
        ? null
        : {
            turnId: `${overrides.id}-turn`,
            state: overrides.latestTurnState,
            requestedAt: "2026-08-19T00:00:00.000Z",
            startedAt: "2026-08-19T00:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
    session:
      overrides.sessionStatus == null && overrides.providerName == null
        ? null
        : {
            threadId: overrides.id,
            status: overrides.sessionStatus ?? "idle",
            providerName: overrides.providerName ?? null,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-08-19T00:00:00.000Z",
          },
  };
  return shell as unknown as EnvironmentThreadShell;
}

/** Recursively collect elements carrying a given data-testid from an element tree. */
function collectByTestId(node: unknown, testId: string, acc: ReactElement[]): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectByTestId(child, testId, acc);
    return acc;
  }
  if (!isValidElement(node)) {
    return acc;
  }
  const props = node.props as { "data-testid"?: string; children?: unknown };
  if (props["data-testid"] === testId) {
    acc.push(node);
  }
  if (props.children !== undefined) {
    collectByTestId(props.children, testId, acc);
  }
  return acc;
}

describe("WorkjetWorkerOverview", () => {
  const orchestratorId = "orch-1" as ThreadId;
  const orchestrator = makeShell({
    id: "orch-1",
    title: "Orchestrator",
    workjetConfig: orchestratorConfig(),
  });

  it("renders its worker children with model, provider, and turn state", () => {
    const workerOne = makeShell({
      id: "worker-1",
      title: "Build the login form",
      workjetConfig: workerConfig(orchestratorId),
      model: "gpt-5.6-sol",
      providerName: "claude",
      sessionStatus: "running",
    });
    const workerTwo = makeShell({
      id: "worker-2",
      title: "Audit the payment flow",
      workjetConfig: workerConfig(orchestratorId),
      latestTurnState: "completed",
    });

    const markup = renderToStaticMarkup(
      <WorkjetWorkerOverview
        environmentId={envA}
        orchestratorThreadId={orchestratorId}
        threads={[orchestrator, workerOne, workerTwo]}
        onOpenWorker={() => {}}
      />,
    );

    expect(markup).toContain("Workers (2)");
    expect(markup).toContain("Build the login form");
    expect(markup).toContain("Audit the payment flow");
    // Provider binding shown when present; model always shown.
    expect(markup).toContain("claude · gpt-5.6-sol");
    // Turn state labels derived from session/latestTurn.
    expect(markup).toContain("Running");
    expect(markup).toContain("Completed");
  });

  it("renders nothing when the open thread is not an orchestrator", () => {
    const standard = makeShell({ id: "plain-1", title: "Plain", workjetConfig: standardConfig() });
    const worker = makeShell({
      id: "worker-1",
      title: "Orphan-linked",
      workjetConfig: workerConfig("plain-1" as ThreadId),
    });

    const markup = renderToStaticMarkup(
      <WorkjetWorkerOverview
        environmentId={envA}
        orchestratorThreadId={"plain-1" as ThreadId}
        threads={[standard, worker]}
        onOpenWorker={() => {}}
      />,
    );

    expect(markup).toBe("");
  });

  it("opens the ordinary worker thread when a row is clicked", () => {
    const worker = makeShell({
      id: "worker-1",
      title: "Build the login form",
      workjetConfig: workerConfig(orchestratorId),
    });
    const onOpenWorker = vi.fn();

    const element = WorkjetWorkerOverview({
      environmentId: envA,
      orchestratorThreadId: orchestratorId,
      threads: [orchestrator, worker],
      onOpenWorker,
    });
    const rows = collectByTestId(element, "workjet-worker-row", []);
    expect(rows).toHaveLength(1);

    (rows[0]!.props as { onClick: () => void }).onClick();

    expect(onOpenWorker).toHaveBeenCalledTimes(1);
    expect(onOpenWorker).toHaveBeenCalledWith({
      environmentId: envA,
      threadId: "worker-1",
    });
  });
});

describe("buildWorkerOverviewRows", () => {
  it("keeps worker threads present in the source list (overview is a derived view)", () => {
    // Guarantee: deriving the overview never removes worker threads from the
    // list the sidebar renders — they remain ordinary threads even when this
    // overview is absent.
    const orchestrator = makeShell({
      id: "orch-1",
      title: "Orchestrator",
      workjetConfig: orchestratorConfig(),
    });
    const worker = makeShell({
      id: "worker-1",
      title: "Worker",
      workjetConfig: workerConfig("orch-1" as ThreadId),
    });
    const threads = [orchestrator, worker];

    const rows = buildWorkerOverviewRows(threads, envA, "orch-1" as ThreadId);

    // The overview lists the worker...
    expect(rows.map((row) => row.threadId)).toEqual(["worker-1"]);
    // ...and the source thread list is untouched: the worker is still an
    // ordinary thread the sidebar would render.
    expect(threads).toHaveLength(2);
    expect(threads.some((thread) => thread.id === ("worker-1" as ThreadId))).toBe(true);
  });
});

describe("resolveWorkerTurnState", () => {
  it("prefers a live running session over the latest turn record", () => {
    expect(
      resolveWorkerTurnState({
        latestTurn: null,
        session: {
          threadId: "worker-1" as ThreadId,
          status: "running",
          providerName: null,
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
      } as unknown as Pick<EnvironmentThreadShell, "latestTurn" | "session">),
    ).toBe("running");
  });

  it("falls back to idle when there is no turn or session", () => {
    expect(
      resolveWorkerTurnState({ latestTurn: null, session: null } as Pick<
        EnvironmentThreadShell,
        "latestTurn" | "session"
      >),
    ).toBe("idle");
  });
});
