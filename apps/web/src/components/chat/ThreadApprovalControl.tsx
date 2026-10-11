import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from "@workjet/contracts";
import { useState } from "react";

/** Saved per-thread permission override, applied to the next provider turn. */
export function ThreadApprovalControl({
  runtimeMode,
  projectRuntimeMode = DEFAULT_RUNTIME_MODE,
  hasOwnWorktree = false,
  disabled = false,
  onChange,
}: {
  readonly runtimeMode: RuntimeMode;
  readonly projectRuntimeMode?: RuntimeMode;
  readonly hasOwnWorktree?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (mode: RuntimeMode) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const projectPolicy = hasOwnWorktree
    ? projectRuntimeMode
    : projectRuntimeMode === "approval-required"
      ? "approval-required"
      : "auto-accept-edits";
  return (
    <span className="no-drag inline-flex items-center gap-2 text-xs text-secondary-label">
      <select
        aria-label="Freigaberegel"
        className="rounded border border-border bg-background px-1 py-0.5"
        value={runtimeMode === projectPolicy ? "project" : runtimeMode}
        disabled={disabled || saving}
        onChange={async (event) => {
          const value = event.currentTarget.value;
          const mode = value === "project" ? projectPolicy : (value as RuntimeMode);
          if (!hasOwnWorktree && (mode === "full-access" || mode === "auto")) return;
          setSaving(true);
          setError(false);
          try {
            setError(!(await onChange(mode)));
          } catch {
            setError(true);
          } finally {
            setSaving(false);
          }
        }}
      >
        <option value="project">Projektregel</option>
        <option value="approval-required">Freigabe nötig</option>
        <option value="auto" disabled={!hasOwnWorktree}>
          Workspace-Autonomie
        </option>
        <option value="auto-accept-edits">Änderungen annehmen</option>
        <option value="full-access" disabled={!hasOwnWorktree}>
          Vollzugriff
        </option>
      </select>
      {error ? <span role="status">Regel nicht gespeichert</span> : null}
    </span>
  );
}
