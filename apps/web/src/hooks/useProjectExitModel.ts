import { useCallback, useEffect, useRef, useState } from "react";
import {
  ProjectId,
  type WorkjetExitModelAssessment,
  type WorkjetExitModelResources,
} from "@workjet/contracts";
import { readActiveWorkjetScope, useActiveWorkjetScope } from "../activeWorkjetScope";
import { refreshWorkjetProjectRegistry } from "../workjetProjectRegistry";
import { requestProjectExitModel } from "../projectExitModel";
import { newCommandId } from "../lib/utils";

type State = {
  key: string;
  assessment: WorkjetExitModelAssessment | null;
  pending: "read" | "refresh" | "submit" | null;
  error: string | null;
};

type Retry = { key: string; commandId: ReturnType<typeof newCommandId> };

export function useProjectExitModel(
  instanceId: string | null,
  projectId: string,
  seed: WorkjetExitModelAssessment | null | undefined,
) {
  const scope = useActiveWorkjetScope();
  const key = JSON.stringify([instanceId, projectId, scope.selectionRevision]);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const refreshRetry = useRef<Retry | null>(null);
  const submitRetry = useRef<Retry | null>(null);
  const assessmentRef = useRef<WorkjetExitModelAssessment | null>(seed ?? null);
  const initialAssessment = useRef(seed);
  initialAssessment.current = seed;
  const [state, setState] = useState<State>({
    key,
    assessment: seed ?? null,
    pending: null,
    error: null,
  });

  const request = useCallback(
    async (
      action:
        | "project.exit_model.read"
        | "project.exit_model.refresh"
        | "project.exit_model.submit",
      resources?: WorkjetExitModelResources,
      confirmRunId?: string,
    ): Promise<boolean> => {
      if (
        instanceId === null ||
        inFlight.current ||
        readActiveWorkjetScope().selectedInstanceId !== instanceId ||
        readActiveWorkjetScope().selectionRevision !== scope.selectionRevision
      )
        return false;
      const token = ++generation.current;
      inFlight.current = true;
      const retryKey = JSON.stringify([key, action, resources ?? null, confirmRunId ?? null]);
      let commandId: ReturnType<typeof newCommandId>;
      if (action === "project.exit_model.refresh") {
        if (refreshRetry.current?.key !== retryKey)
          refreshRetry.current = { key: retryKey, commandId: newCommandId() };
        commandId = refreshRetry.current.commandId;
      } else if (action === "project.exit_model.submit") {
        if (submitRetry.current?.key !== retryKey)
          submitRetry.current = { key: retryKey, commandId: newCommandId() };
        commandId = submitRetry.current.commandId;
      } else commandId = newCommandId();
      setState((previous) => ({
        key,
        assessment:
          previous.key === key ? previous.assessment : (initialAssessment.current ?? null),
        pending:
          action === "project.exit_model.read"
            ? "read"
            : action === "project.exit_model.refresh"
              ? "refresh"
              : "submit",
        error: null,
      }));
      const project = ProjectId.make(projectId);
      const result = await requestProjectExitModel(
        instanceId,
        action === "project.exit_model.submit"
          ? { action, commandId, projectId: project, confirmRunId: confirmRunId ?? "" }
          : action === "project.exit_model.refresh"
            ? { action, commandId, projectId: project, ...(resources ? { resources } : {}) }
            : { action, commandId, projectId: project },
      );
      if (token !== generation.current) return false;
      inFlight.current = false;
      if (
        readActiveWorkjetScope().selectedInstanceId !== instanceId ||
        readActiveWorkjetScope().selectionRevision !== scope.selectionRevision
      ) {
        setState({ key, assessment: null, pending: null, error: null });
        return false;
      }
      if (result._tag === "failed") {
        // Adoption keeps its command id until a correlated success. A definite
        // rejection (stale proposal, expired sources) reads the card again.
        // Timeouts and uncorrelated receipts do not paint a value or an error.
        if (action === "project.exit_model.submit") {
          setState((previous) => ({ ...previous, pending: null, error: null }));
          if (result.reason !== "timeout" && result.reason !== "uncorrelated")
            await request("project.exit_model.read");
          return false;
        }
        setState((previous) => ({ ...previous, pending: null, error: result.message }));
        return false;
      }
      if (action === "project.exit_model.refresh") refreshRetry.current = null;
      if (action === "project.exit_model.submit") submitRetry.current = null;
      setState({ key, assessment: result.assessment, pending: null, error: null });
      if (action === "project.exit_model.refresh" || action === "project.exit_model.submit")
        refreshWorkjetProjectRegistry(instanceId);
      return true;
    },
    [instanceId, key, projectId, scope.selectionRevision],
  );

  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    refreshRetry.current = null;
    submitRetry.current = null;
    setState({ key, assessment: initialAssessment.current ?? null, pending: null, error: null });
    if (instanceId !== null) void request("project.exit_model.read");
    return () => {
      generation.current++;
      inFlight.current = false;
    };
  }, [key, instanceId, request]);

  const visible =
    state.key === key ? state : { key, assessment: seed ?? null, pending: null, error: null };

  // Observe only the open project's active research, serially and for a bounded window.
  useEffect(() => {
    if (visible.assessment?.status !== "researching" || instanceId === null) return;
    const deadline = Date.now() + 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const check = async () => {
      if (cancelled || Date.now() >= deadline) return;
      if (!inFlight.current) await request("project.exit_model.read");
      if (!cancelled && Date.now() < deadline) timer = setTimeout(check, 5_000);
    };
    timer = setTimeout(check, 5_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [instanceId, key, request, visible.assessment?.status]);

  assessmentRef.current = visible.assessment;
  return {
    ...visible,
    connected: instanceId !== null && scope.selectedInstanceId === instanceId,
    refresh: (resources?: WorkjetExitModelResources) =>
      request("project.exit_model.refresh", resources),
    confirm: () => {
      const runId = assessmentRef.current?.run_id;
      if (runId == null) return Promise.resolve(false);
      return request("project.exit_model.submit", undefined, runId);
    },
    check: () => request("project.exit_model.read"),
  };
}
