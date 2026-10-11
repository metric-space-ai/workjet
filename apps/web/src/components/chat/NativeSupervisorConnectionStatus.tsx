import type { ReactNode } from "react";
import type { WorkerSourceConnectionStatus } from "./NativeWorkerSourceControl";
import { WorkerSourceConnectionPicker } from "./WorkerSourceConnectionPicker";

export function NativeSupervisorConnectionStatus(props: {
  readonly message: string | null;
  readonly workerStatus: WorkerSourceConnectionStatus | null;
  readonly recoveryAction?: ReactNode;
}) {
  if (!props.message && !props.workerStatus?.choice) return null;
  return (
    <div
      role="status"
      data-supervisor-connection-status="true"
      className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>{props.message}</span>
      {props.workerStatus?.choice ? (
        <WorkerSourceConnectionPicker
          choice={props.workerStatus.choice}
          disabled={props.workerStatus.disabled}
        />
      ) : (
        props.recoveryAction
      )}
    </div>
  );
}
