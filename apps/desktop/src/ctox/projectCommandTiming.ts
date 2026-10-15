// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Self-contained: the same sanitizer executes in the isolated guest before IPC.
export function sanitizeProjectCommandTiming(raw: unknown):
  | {
      commandId: string;
      stagesMs: Record<string, number>;
      pendingStage?: string;
      pendingMs?: number;
    }
  | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const sample = raw as {
    commandId?: unknown;
    stagesMs?: unknown;
    pendingStage?: unknown;
    pendingMs?: unknown;
  };
  if (
    typeof sample.commandId !== "string" ||
    !/^cmd_workjet_project_list_[a-zA-Z0-9_-]{1,100}$/.test(sample.commandId) ||
    typeof sample.stagesMs !== "object" ||
    sample.stagesMs === null
  )
    return undefined;
  const stagesMs: Record<string, number> = {};
  for (const stage of [
    "initial_capability",
    "document_and_database",
    "sync_readiness",
    "fresh_peer_authority",
    "dependencies_and_revalidation",
    "local_persistence",
    "browser_insert",
    "push",
    "local_to_native_intake",
    "native_processing",
    "projection_commit",
    "commit_to_browser_observed",
    "total",
  ]) {
    const duration = (sample.stagesMs as Record<string, unknown>)[stage];
    if (
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= 0 &&
      duration <= 600_000
    )
      stagesMs[stage] = duration;
  }
  const pendingStage = sample.pendingStage;
  const pendingMs = sample.pendingMs;
  return {
    commandId: sample.commandId,
    stagesMs,
    ...(typeof pendingStage === "string" &&
    [
      "initial_capability",
      "document_and_database",
      "sync_readiness",
      "fresh_peer_authority",
      "dependencies_and_revalidation",
      "local_persistence",
    ].includes(pendingStage) &&
    typeof pendingMs === "number" &&
    Number.isFinite(pendingMs) &&
    pendingMs >= 0 &&
    pendingMs <= 600_000
      ? { pendingStage, pendingMs }
      : {}),
  };
}
