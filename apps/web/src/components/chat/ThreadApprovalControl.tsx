import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from "@workjet/contracts";
import { useState } from "react";

/** Saved per-thread permission override, applied to the next provider turn. */
export function ThreadApprovalControl({
  runtimeMode,
  projectRuntimeMode = DEFAULT_RUNTIME_MODE,
  disabled = false,
  onChange,
}: {
  readonly runtimeMode: RuntimeMode;
  readonly projectRuntimeMode?: RuntimeMode;
  readonly disabled?: boolean;
  readonly onChange: (mode: RuntimeMode) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  return (
    <span className="no-drag inline-flex items-center gap-2 text-xs text-secondary-label">
      <select
        aria-label="Thread approval policy"
        className="rounded border border-border bg-background px-1 py-0.5"
        value={runtimeMode === projectRuntimeMode ? "project" : runtimeMode}
        disabled={disabled || saving}
        onChange={async (event) => {
          const value = event.currentTarget.value;
          const mode = value === "project" ? projectRuntimeMode : (value as RuntimeMode);
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
        <option value="project">Project policy</option>
        <option value="approval-required">Require approvals</option>
        <option value="auto">Workspace autonomy</option>
        <option value="auto-accept-edits">Accept workspace edits</option>
        <option value="full-access">Full access</option>
      </select>
      {error ? <span role="status">Policy could not be saved.</span> : null}
    </span>
  );
}
