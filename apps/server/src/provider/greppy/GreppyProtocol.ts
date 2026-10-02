/**
 * Pure Greppy 0.4.x hosted-agent protocol.
 *
 * Workjet talks to `greppy agent serve`. That process prints NDJSON on
 * stdout and accepts JSON-RPC on the unix socket named by the session
 * event. One-shot `greppy -p` is a different mode: it is the only place a
 * wall-clock deadline exists, and it does not keep a workspace open across
 * Workjet turns. Serve publishes a proposal ref when the process exits,
 * not after each turn, and resume restores the transcript only.
 */
export interface GreppyUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface GreppySessionEvent {
  readonly type: "session";
  readonly sessionId: string;
  readonly uri?: string;
  readonly runId?: string;
  readonly project?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly sandbox?: string;
  readonly resumed: boolean;
  readonly socket?: string;
  readonly mode?: string;
}

export interface GreppyTextEvent {
  readonly type: "text";
  readonly text: string;
}

export interface GreppyToolStartEvent {
  readonly type: "tool_start";
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
}

export interface GreppyToolFinishEvent {
  readonly type: "tool_finish";
  readonly id: string;
  readonly failed: boolean;
  readonly elapsedMs?: number;
  readonly preview?: string;
}

export interface GreppyTurnStartEvent {
  readonly type: "turn_start";
  readonly promptId?: string;
  readonly source?: string;
  readonly text?: string;
}

export interface GreppyTurnCompleteEvent {
  readonly type: "turn_complete";
  readonly stop: string;
  readonly promptId?: string;
  readonly usage?: GreppyUsage;
}

export interface GreppyPhaseEvent {
  readonly type: "phase";
  readonly phase: string;
}

export interface GreppyErrorEvent {
  readonly type: "error";
  readonly message: string;
}

export interface GreppyResultEvent {
  readonly type: "result";
  readonly status: string;
  readonly exitCode: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly stop?: string;
  readonly turns?: number;
  readonly usage?: GreppyUsage;
  readonly proposalRef?: string;
  readonly commit?: string;
  readonly stat?: string;
  readonly patch?: string;
  readonly applied: boolean;
  readonly applyError?: string;
}

export interface GreppyUnknownEvent {
  readonly type: "unknown";
  readonly rawType: string;
}

export type GreppyNdjsonEvent =
  | GreppySessionEvent
  | GreppyTextEvent
  | GreppyToolStartEvent
  | GreppyToolFinishEvent
  | GreppyTurnStartEvent
  | GreppyTurnCompleteEvent
  | GreppyPhaseEvent
  | GreppyErrorEvent
  | GreppyResultEvent
  | GreppyUnknownEvent;

export type GreppyTurnState = "completed" | "failed" | "cancelled";

export interface GreppyStopMapping {
  readonly state: GreppyTurnState;
  readonly incomplete: boolean;
  readonly stopReason: string;
}

export interface GreppyResumeCursor {
  readonly version: 1;
  readonly kind: "greppy-session";
  readonly sessionId: string;
  readonly runId?: string;
  readonly project?: string;
}

export const GREPPY_DISABLED_MESSAGE = "Greppy is disabled in Workjet settings.";
export const GREPPY_MISSING_MESSAGE = "Greppy (`greppy`) is not installed or not on PATH.";
export const GREPPY_HTTPS_MESSAGE = "Greppy only reaches plain HTTP gateways.";
export const GREPPY_MODEL_MESSAGE =
  "Set a model id. Greppy passes it through to the gateway unchanged.";
export const GREPPY_TEXT_GENERATION_MESSAGE = "Greppy only runs hosted agent turns.";

export const greppyVersionRefusal = (version: string): string =>
  `This Greppy is ${version}. Workjet's Greppy harness needs 0.4.x.`;

export const greppyInstalledMessage = (version: string): string =>
  `Greppy ${version} is installed. Workjet checks the model gateway when a thread starts.`;

const INCOMPLETE_STOPS = new Set([
  "token limit reached",
  "turn limit reached",
  "deadline reached",
  "stopped after repeated tool failures",
  "max_tokens",
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const usageFrom = (value: unknown): GreppyUsage | undefined => {
  const record = asRecord(value);
  if (record === null) return undefined;
  return {
    input: asNumber(record.input),
    output: asNumber(record.output),
    cacheRead: asNumber(record.cache_read),
    cacheWrite: asNumber(record.cache_write),
  };
};

/**
 * Parse one NDJSON line. Blank lines and non-JSON (the CLI's pre-session
 * usage errors go to stderr and produce no JSON) return null.
 */
export const parseGreppyNdjsonLine = (line: string): GreppyNdjsonEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null || typeof record.type !== "string") return null;
  switch (record.type) {
    case "session": {
      const sessionId = asString(record.session_id);
      if (sessionId === undefined) return null;
      return {
        type: "session",
        sessionId,
        ...(asString(record.uri) ? { uri: asString(record.uri) } : {}),
        ...(asString(record.run_id) ? { runId: asString(record.run_id) } : {}),
        ...(asString(record.project) ? { project: asString(record.project) } : {}),
        ...(asString(record.worktree) ? { worktree: asString(record.worktree) } : {}),
        ...(asString(record.branch) ? { branch: asString(record.branch) } : {}),
        ...(asString(record.model) ? { model: asString(record.model) } : {}),
        ...(asString(record.endpoint) ? { endpoint: asString(record.endpoint) } : {}),
        ...(asString(record.sandbox) ? { sandbox: asString(record.sandbox) } : {}),
        resumed: record.resumed === true,
        ...(asString(record.socket) ? { socket: asString(record.socket) } : {}),
        ...(asString(record.mode) ? { mode: asString(record.mode) } : {}),
      };
    }
    case "text":
      return { type: "text", text: typeof record.text === "string" ? record.text : "" };
    case "tool_start": {
      const id = asString(record.id);
      const name = asString(record.name);
      if (id === undefined || name === undefined) return null;
      return {
        type: "tool_start",
        id,
        name,
        ...(asString(record.summary) ? { summary: asString(record.summary) } : {}),
      };
    }
    case "tool_finish": {
      const id = asString(record.id);
      if (id === undefined) return null;
      const elapsed = record.elapsed_ms;
      return {
        type: "tool_finish",
        id,
        failed: record.failed === true,
        ...(typeof elapsed === "number" && Number.isFinite(elapsed) ? { elapsedMs: elapsed } : {}),
        ...(asString(record.preview) ? { preview: asString(record.preview) } : {}),
      };
    }
    case "turn_start":
      return {
        type: "turn_start",
        ...(asString(record.prompt_id) ? { promptId: asString(record.prompt_id) } : {}),
        ...(asString(record.source) ? { source: asString(record.source) } : {}),
        ...(asString(record.text) ? { text: asString(record.text) } : {}),
      };
    case "turn_complete":
      return {
        type: "turn_complete",
        stop: typeof record.stop === "string" ? record.stop : "",
        ...(asString(record.prompt_id) ? { promptId: asString(record.prompt_id) } : {}),
        ...(usageFrom(record.usage) ? { usage: usageFrom(record.usage) } : {}),
      };
    case "phase":
      return { type: "phase", phase: typeof record.phase === "string" ? record.phase : "" };
    case "error":
      return {
        type: "error",
        message: typeof record.message === "string" ? record.message : "Greppy reported an error.",
      };
    case "result": {
      const exitCode = typeof record.exit_code === "number" ? record.exit_code : 1;
      return {
        type: "result",
        status: typeof record.status === "string" ? record.status : "error",
        exitCode,
        ...(asString(record.session_id) ? { sessionId: asString(record.session_id) } : {}),
        ...(asString(record.run_id) ? { runId: asString(record.run_id) } : {}),
        ...(asString(record.stop) ? { stop: asString(record.stop) } : {}),
        ...(typeof record.turns === "number" ? { turns: record.turns } : {}),
        ...(usageFrom(record.usage) ? { usage: usageFrom(record.usage) } : {}),
        ...(asString(record.proposal_ref) ? { proposalRef: asString(record.proposal_ref) } : {}),
        ...(asString(record.commit) ? { commit: asString(record.commit) } : {}),
        ...(typeof record.stat === "string" && record.stat.length > 0 ? { stat: record.stat } : {}),
        ...(typeof record.patch === "string" && record.patch.length > 0
          ? { patch: record.patch }
          : {}),
        applied: record.applied === true,
        ...(asString(record.apply_error) ? { applyError: asString(record.apply_error) } : {}),
      };
    }
    default:
      return { type: "unknown", rawType: record.type };
  }
};

/**
 * Map a serve stop label, and the result exit code when the process is
 * ending, onto Workjet's turn state.
 *
 * Exit 5 is the installed 0.4.1 "incomplete" code (turn, token, or
 * deadline limit, or repeated tool failures) even when the proposal was
 * saved. Exit 130 is the signal cancel. There is no separate "incomplete"
 * turn state, so a limit is a completed turn plus a warning.
 */
export const mapGreppyStop = (stop: string, exitCode?: number): GreppyStopMapping => {
  const label = stop.trim();
  const normalized = label.toLowerCase();
  if (exitCode === 130 || normalized === "cancelled") {
    return { state: "cancelled", incomplete: false, stopReason: label || "cancelled" };
  }
  if (exitCode === 5 || INCOMPLETE_STOPS.has(normalized)) {
    return {
      state: "completed",
      incomplete: true,
      stopReason: label || "incomplete",
    };
  }
  if (
    normalized === "ready" ||
    normalized === "end_turn" ||
    normalized === "tool_use" ||
    normalized === ""
  ) {
    return { state: "completed", incomplete: false, stopReason: label || "ready" };
  }
  if (exitCode !== undefined && exitCode !== 0) {
    return { state: "failed", incomplete: false, stopReason: label || `exit ${exitCode}` };
  }
  return { state: "completed", incomplete: false, stopReason: label };
};

export const classifyGreppyResult = (
  result: GreppyResultEvent,
): { readonly exitKind: "graceful" | "error"; readonly turn: GreppyStopMapping } => {
  const turn = mapGreppyStop(result.stop ?? result.status, result.exitCode);
  if (result.status === "cancelled" || result.exitCode === 130) {
    return {
      exitKind: "graceful",
      turn: { state: "cancelled", incomplete: false, stopReason: result.stop ?? "cancelled" },
    };
  }
  if (result.status === "error" || (result.exitCode !== 0 && result.exitCode !== 5)) {
    return {
      exitKind: "error",
      turn: { ...turn, state: turn.state === "cancelled" ? "cancelled" : "failed" },
    };
  }
  return { exitKind: "graceful", turn };
};

export const greppyProposalMessage = (result: GreppyResultEvent): string | null => {
  if (result.proposalRef === undefined) return null;
  const applied = result.applied
    ? "Greppy reported the proposal as applied."
    : "Greppy saved the proposal and did not apply it. Resume restores the transcript only; unapplied edits stay on that ref.";
  const stat = result.stat ? ` ${result.stat.trim()}` : "";
  return `Greppy proposal ${result.proposalRef}.${stat} ${applied}`.replace(/\s+/g, " ").trim();
};

export type GreppyVersionClass =
  | { readonly kind: "supported"; readonly version: string }
  | { readonly kind: "unsupported"; readonly version: string }
  | { readonly kind: "unparsed" };

export const classifyGreppyVersion = (output: string): GreppyVersionClass => {
  const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (version === undefined) return { kind: "unparsed" };
  if (version.startsWith("0.4.")) return { kind: "supported", version };
  return { kind: "unsupported", version };
};

/** Bare `http://` root. Greppy appends `/v1/messages` and `/v1/models` itself. */
export const plainHttpEndpoint = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\s\u0000]/.test(trimmed)) return null;
  if (!trimmed.toLowerCase().startsWith("http://")) return null;
  return trimmed.replace(/\/+$/, "");
};

export const safeGreppyModelId = (value: string): string | null => {
  const model = value.trim();
  if (model.length === 0 || model.length > 200) return null;
  if (model.startsWith("-") || /[\s\u0000]/.test(model)) return null;
  return model;
};

export const safeGreppySessionId = (value: string): string | null => {
  const sessionId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/.test(sessionId)) return null;
  return sessionId;
};

export const clampGreppyMaxTurns = (value: number): number => {
  if (!Number.isFinite(value)) return 40;
  return Math.min(200, Math.max(1, Math.trunc(value)));
};

export const GREPPY_PROPOSAL_REF = /^refs\/greppy\/agent\/[A-Za-z0-9._:-]{1,200}$/;

export const greppyServeArguments = (input: {
  readonly model: string;
  readonly endpoint: string;
  readonly resumeSessionId?: string | undefined;
  readonly maxTurns: number;
  readonly noSandbox: boolean;
  readonly skipSelfCheck: boolean;
}): ReadonlyArray<string> => {
  const args = [
    "agent",
    "serve",
    "--model",
    input.model,
    "--endpoint",
    input.endpoint,
    "--max-turns",
    String(clampGreppyMaxTurns(input.maxTurns)),
  ];
  if (input.resumeSessionId !== undefined) {
    args.push("--resume", input.resumeSessionId);
  }
  if (input.noSandbox) args.push("--no-sandbox=true");
  if (input.skipSelfCheck) args.push("--skip-selfcheck=true");
  return args;
};

export const encodeGreppyResumeCursor = (input: {
  readonly sessionId: string;
  readonly runId?: string | undefined;
  readonly project?: string | undefined;
}): GreppyResumeCursor => ({
  version: 1,
  kind: "greppy-session",
  sessionId: input.sessionId,
  ...(input.runId ? { runId: input.runId } : {}),
  ...(input.project ? { project: input.project } : {}),
});

export const decodeGreppyResumeCursor = (value: unknown): GreppyResumeCursor | null => {
  const record = asRecord(value);
  if (record === null) return null;
  if (record.version !== 1 || record.kind !== "greppy-session") return null;
  const sessionId = typeof record.sessionId === "string" ? safeGreppySessionId(record.sessionId) : null;
  if (sessionId === null) return null;
  const runId = asString(record.runId);
  const project = asString(record.project);
  return {
    version: 1,
    kind: "greppy-session",
    sessionId,
    ...(runId ? { runId } : {}),
    ...(project ? { project } : {}),
  };
};

export const greppyIncompleteWarning = (stopReason: string): string =>
  `Greppy stopped this turn early (${stopReason}). The session is still open. A proposal saved at session exit can be incomplete.`;
