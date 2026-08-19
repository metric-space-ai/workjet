import * as Data from "effect/Data";

export class SshHostDiscoveryError extends Data.TaggedError("SshHostDiscoveryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SshInvalidTargetError extends Data.TaggedError("SshInvalidTargetError")<{
  readonly message: string;
}> {}

export class SshCommandError extends Data.TaggedError("SshCommandError")<{
  readonly message: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout?: string;
  readonly cause?: unknown;
}> {}

export class SshLaunchError extends Data.TaggedError("SshLaunchError")<{
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshPairingError extends Data.TaggedError("SshPairingError")<{
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshHttpBridgeError extends Data.TaggedError("SshHttpBridgeError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class SshReadinessError extends Data.TaggedError("SshReadinessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Every way a scoped `ssh -L` local forward can fail, as one bounded reason.
 * Callers outside this package surface the reason, never the cause: the cause
 * may quote a destination, a path, or remote stderr.
 */
export type SshTunnelErrorReason =
  | "invalid_port"
  | "invalid_target"
  | "local_port_unavailable"
  | "spawn_failed"
  | "startup_timeout"
  | "process_exited";

export class SshTunnelError extends Data.TaggedError("SshTunnelError")<{
  readonly reason: SshTunnelErrorReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SshPasswordPromptError extends Data.TaggedError("SshPasswordPromptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
