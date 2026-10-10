import type { WorkjetWorkerProfile } from "@workjet/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { readActiveWorkjetScope } from "../../activeWorkjetScope";
import { newCommandId } from "../../lib/utils";
import type { NativeSupervisorScope } from "../../nativeSupervisorComposer";
import {
  recordWorkjetProjectProjection,
  refreshWorkjetProjectRegistry,
  useWorkjetProjectRegistry,
} from "../../workjetProjectRegistry";
import { saveSupervisorLuma } from "../../workjetSupervisorLuma";
import { useProjectSupervisorLumas } from "../ProjectSupervisorLumaField";
import { workjetHarnessDisplayLabel } from "../settings/WorkjetWorkerEditor";
import { ComposerControl } from "./ComposerControl";

export function NativeSupervisorRouteControls(props: {
  readonly scope: NativeSupervisorScope | null;
  readonly disabled: boolean;
  readonly routeTitle: string;
  readonly onSavingChange: (saving: boolean) => void;
}) {
  const registry = useWorkjetProjectRegistry(props.scope?.instanceId ?? null);
  const lumas = useProjectSupervisorLumas();
  const navigate = useNavigate();
  const project = registry.projects.find((entry) => entry.id === props.scope?.projectId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify(props.scope);
  const currentKey = useRef(scopeKey);
  currentKey.current = scopeKey;
  const ready =
    props.scope !== null &&
    registry.presentationInstanceId === props.scope.instanceId &&
    lumas.instanceId === props.scope.instanceId &&
    lumas.phase === "ready" &&
    project !== undefined;

  useEffect(() => {
    setError(null);
    return () => {
      operation.current?.abort();
      operation.current = null;
      props.onSavingChange(false);
    };
  }, [scopeKey, props.onSavingChange]);

  async function choose(lumaId: string | null) {
    if (!ready || !props.scope || !project || props.disabled || operation.current) return;
    if (lumaId !== null && !lumas.profiles.some((profile) => profile.id === lumaId)) return;
    if ((project.supervisorLumaId ?? null) === lumaId) return;
    const controller = new AbortController();
    operation.current = controller;
    const selection = readActiveWorkjetScope();
    const scope = props.scope;
    setSaving(true);
    props.onSavingChange(true);
    setError(null);
    const result = await saveSupervisorLuma({
      scope,
      project,
      lumaId,
      commandId: newCommandId(),
      signal: controller.signal,
      isCurrent: () =>
        currentKey.current === scopeKey &&
        readActiveWorkjetScope().selectedInstanceId === scope.instanceId &&
        readActiveWorkjetScope().selectionRevision === selection.selectionRevision,
    });
    if (operation.current !== controller) return;
    operation.current = null;
    setSaving(false);
    props.onSavingChange(false);
    if (result.phase === "saved") {
      recordWorkjetProjectProjection(scope.instanceId, {
        ...project,
        ...result.project,
      });
      refreshWorkjetProjectRegistry(scope.instanceId);
    } else if (result.phase === "failed") setError(result.error);
  }

  return (
    <NativeSupervisorRouteControlsView
      value={project?.supervisorLumaId ?? null}
      profiles={ready ? lumas.profiles : []}
      disabled={props.disabled || saving || !ready}
      phase={ready ? "ready" : lumas.phase === "loading" ? "loading" : "unavailable"}
      saving={saving}
      error={error}
      routeTitle={props.routeTitle}
      instanceName={
        lumas.instanceId === props.scope?.instanceId
          ? (lumas.instanceName ?? "Project instance")
          : "Project instance"
      }
      onChange={(value) => void choose(value)}
      onConfigureWorkers={() => void navigate({ to: "/settings/workjet" })}
      onConfigureInstance={() => void navigate({ to: "/settings/business-os" })}
    />
  );
}

/** Model choices are validated instance Luma routes, never a client-supplied model override. */
export function NativeSupervisorRouteControlsView(props: {
  readonly value: string | null;
  readonly profiles: readonly WorkjetWorkerProfile[];
  readonly disabled: boolean;
  readonly phase: "loading" | "ready" | "unavailable";
  readonly saving: boolean;
  readonly error: string | null;
  readonly routeTitle: string;
  readonly instanceName: string;
  readonly onChange: (value: string | null) => void;
  readonly onConfigureWorkers: () => void;
  readonly onConfigureInstance: () => void;
}) {
  const selected = props.profiles.find((profile) => profile.id === props.value);
  const title = props.saving
    ? "Saving Supervisor selection…"
    : props.phase === "ready"
      ? "Choose the Worker and its model for this project's next Supervisor turn."
      : props.phase === "loading"
        ? "Loading instance Workers…"
        : "Instance Workers are unavailable. The saved route is retained.";
  const selectClass =
    "h-[var(--composer-control-height,1.75rem)] max-w-72 cursor-pointer rounded-md bg-transparent px-1 text-[length:var(--composer-control-font-size,13px)] text-secondary-label outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60";
  return (
    <>
      <select
        aria-label="Supervisor Worker"
        title={title}
        className={selectClass}
        value={props.value ?? ""}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value || null)}
      >
        <option value="">Supervisor · Instance default</option>
        {props.value !== null && selected === undefined && (
          <option value={props.value}>Saved Worker unavailable</option>
        )}
        {props.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Supervisor model"
        title={`${title} ${props.routeTitle}`}
        className={selectClass}
        value={props.value ?? ""}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value || null)}
      >
        <option value="">Instance model</option>
        {props.value !== null && selected === undefined && (
          <option value={props.value}>Saved model unavailable</option>
        )}
        {props.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {workjetHarnessDisplayLabel(profile.harness)} · {profile.modelId}
          </option>
        ))}
      </select>
      <ComposerControl
        type="button"
        onClick={props.onConfigureInstance}
        title="Open the project's CTOX instance settings. This chat stays bound to its project."
      >
        {props.instanceName}
      </ComposerControl>
      {(props.phase !== "ready" || props.profiles.length === 0) && (
        <ComposerControl type="button" onClick={props.onConfigureWorkers} title={title}>
          Configure Workers
        </ComposerControl>
      )}
      {(props.saving || props.error) && (
        <span role={props.error ? "alert" : "status"} className="text-xs text-muted-foreground">
          {props.error ?? "Saving…"}
        </span>
      )}
    </>
  );
}
