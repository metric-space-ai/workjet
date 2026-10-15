import {
  EnvironmentId,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationProposedPlan,
  OrchestrationCheckpointSummary,
  type ScopedThreadRef,
} from "@workjet/contracts";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@workjet/client-runtime/state/shell";
import type { EnvironmentThreadState } from "@workjet/client-runtime/state/threads";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useMemo } from "react";
import { getCtoxClient, type CtoxAppApi } from "./ctoxClient";
import { useCtoxDoc, useCtoxMetrics, useCtoxQuery } from "./hooks";

/** App-owned typed view of computer-originated harness data, not a copy of user_threads. */
const WorkjetThreadRow = Schema.Struct({
  ...OrchestrationThreadShell.fields,
  environmentId: EnvironmentId,
});
export type WorkjetThreadDocument = typeof WorkjetThreadRow.Type;
const decodeShell = Schema.decodeUnknownSync(WorkjetThreadRow);
const decodeDetail = Schema.decodeUnknownSync(OrchestrationThread);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationMessage);
const decodeActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);
const decodePlan = Schema.decodeUnknownSync(OrchestrationProposedPlan);
const decodeCheckpoint = Schema.decodeUnknownSync(OrchestrationCheckpointSummary);
const visibleThreads = { selector: {}, sort: [{ updatedAt: "desc" }] } as const;

export function useWorkjetThreadShells(
  instanceId: string | null,
): readonly EnvironmentThreadShell[] {
  const rows = useCtoxQuery<WorkjetThreadDocument>(instanceId, "workjet_threads", {
    selector: visibleThreads.selector,
    sort: [{ updatedAt: "desc" }],
  });
  return useMemo(
    () => rows.filter((row) => row.deletedAt == null).map((row) => decodeShell(row)),
    [rows],
  );
}

function scopeMatches(row: WorkjetThreadDocument | null, ref: ScopedThreadRef | null) {
  return (
    row !== null &&
    ref !== null &&
    row.id === ref.threadId &&
    row.environmentId === ref.environmentId
  );
}

export function useWorkjetThreadState(
  instanceId: string | null,
  ref: ScopedThreadRef | null,
): EnvironmentThreadState {
  const row = useCtoxDoc<WorkjetThreadDocument>(
    instanceId,
    "workjet_threads",
    ref?.threadId ?? null,
  );
  const matches = scopeMatches(row, ref);
  const scope = matches ? instanceId : null;
  const selector = { thread_id: ref?.threadId ?? null };
  const messages = useCtoxQuery<OrchestrationMessage>(scope, "workjet_thread_messages", {
    selector,
    sort: [{ createdAt: "asc" }],
  });
  const activities = useCtoxQuery<OrchestrationThreadActivity>(scope, "workjet_thread_activities", {
    selector,
  });
  const proposedPlans = useCtoxQuery<OrchestrationProposedPlan>(scope, "workjet_thread_plans", {
    selector,
  });
  const checkpoints = useCtoxQuery<OrchestrationCheckpointSummary>(
    scope,
    "workjet_thread_checkpoints",
    { selector },
  );
  const metrics = useCtoxMetrics(instanceId);
  return useMemo<EnvironmentThreadState>(() => {
    if (!matches)
      return { data: Option.none(), status: "empty", error: Option.none(), page: Option.none() };
    const shell = decodeShell(row);
    if (shell.deletedAt != null)
      return { data: Option.none(), status: "deleted", error: Option.none(), page: Option.none() };
    const data = decodeDetail({
      ...shell,
      deletedAt: shell.deletedAt ?? null,
      messages: messages.map((value) => decodeMessage(value)),
      activities: activities.map((value) => decodeActivity(value)),
      proposedPlans: proposedPlans.map((value) => decodePlan(value)),
      checkpoints: checkpoints.map((value) => decodeCheckpoint(value)),
    });
    return {
      data: Option.some(data),
      status: metrics?.link.state === "online" ? "live" : "cached",
      error: Option.none(),
      page: Option.none(),
    };
  }, [row, matches, messages, activities, proposedPlans, checkpoints, metrics]);
}

export function readWorkjetThreadShells(
  instanceId: string | null,
): readonly EnvironmentThreadShell[] {
  return (
    getCtoxClient(instanceId)
      ?.query<WorkjetThreadDocument>("workjet_threads", {
        selector: visibleThreads.selector,
        sort: [{ updatedAt: "desc" }],
      })
      .get()
      .filter((row) => row.deletedAt == null)
      .map((row) => decodeShell(row)) ?? []
  );
}

export function readWorkjetThreadDetail(
  api: CtoxAppApi | null,
  ref: ScopedThreadRef,
): EnvironmentThread | null {
  if (!api) return null;
  const row = api.get<WorkjetThreadDocument>("workjet_threads", ref.threadId).get();
  if (!scopeMatches(row, ref)) return null;
  const shell = decodeShell(row);
  if (shell.deletedAt != null) return null;
  const query = { selector: { thread_id: ref.threadId } };
  return {
    ...decodeDetail({
      ...shell,
      deletedAt: shell.deletedAt ?? null,
      messages: api
        .query("workjet_thread_messages", { ...query, sort: [{ createdAt: "asc" }] })
        .get()
        .map((value) => decodeMessage(value)),
      activities: api
        .query("workjet_thread_activities", query)
        .get()
        .map((value) => decodeActivity(value)),
      proposedPlans: api
        .query("workjet_thread_plans", query)
        .get()
        .map((value) => decodePlan(value)),
      checkpoints: api
        .query("workjet_thread_checkpoints", query)
        .get()
        .map((value) => decodeCheckpoint(value)),
    }),
    environmentId: shell.environmentId,
  };
}
