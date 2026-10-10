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
  pending: "read" | "refresh" | null;
  error: string | null;
};

export function useProjectExitModel(
  instanceId: string | null,
  projectId: string,
  seed: WorkjetExitModelAssessment | null | undefined,
) {
  const scope = useActiveWorkjetScope();
  const key = JSON.stringify([instanceId, projectId, scope.selectionRevision]);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const retry = useRef<{ key: string; commandId: ReturnType<typeof newCommandId> } | null>(null);
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
      action: "project.exit_model.read" | "project.exit_model.refresh",
      resources?: WorkjetExitModelResources,
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
      const retryKey = JSON.stringify([key, resources ?? null]);
      if (action === "project.exit_model.refresh" && retry.current?.key !== retryKey)
        retry.current = { key: retryKey, commandId: newCommandId() };
      const commandId =
        action === "project.exit_model.refresh" ? retry.current!.commandId : newCommandId();
      setState((previous) => ({
        key,
        assessment:
          previous.key === key ? previous.assessment : (initialAssessment.current ?? null),
        pending: action === "project.exit_model.read" ? "read" : "refresh",
        error: null,
      }));
      const result = await requestProjectExitModel(instanceId, {
        action,
        commandId,
        projectId: ProjectId.make(projectId),
        ...(action === "project.exit_model.refresh" && resources ? { resources } : {}),
      });
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
        setState((previous) => ({ ...previous, pending: null, error: result.message }));
        return false;
      }
      if (action === "project.exit_model.refresh") retry.current = null;
      setState({ key, assessment: result.assessment, pending: null, error: null });
      if (action === "project.exit_model.refresh") refreshWorkjetProjectRegistry(instanceId);
      return true;
    },
    [instanceId, key, projectId, scope.selectionRevision],
  );

  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    retry.current = null;
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

  return {
    ...visible,
    connected: instanceId !== null && scope.selectedInstanceId === instanceId,
    refresh: (resources?: WorkjetExitModelResources) =>
      request("project.exit_model.refresh", resources),
    check: () => request("project.exit_model.read"),
  };
}
