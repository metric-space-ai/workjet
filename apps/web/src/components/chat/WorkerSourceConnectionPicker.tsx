import type { WorkjetConnectionSummary } from "@workjet/contracts";

export interface WorkerSourceConnectionChoice {
  readonly connections: readonly WorkjetConnectionSummary[];
  readonly select: (connectionId: string) => void;
}

export function WorkerSourceConnectionPicker(props: {
  readonly choice: WorkerSourceConnectionChoice;
  readonly disabled: boolean;
}) {
  return (
    <select
      aria-label="Choose worker access"
      className="min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50 sm:max-w-64"
      value=""
      disabled={props.disabled}
      onChange={(event) => props.choice.select(event.target.value)}
    >
      <option value="" disabled>
        Choose worker access…
      </option>
      {props.choice.connections.map((entry) => (
        <option key={entry.connectionId} value={entry.connectionId}>
          {entry.displayName} · {entry.connectionId.split(":").at(-1)?.slice(0, 8)}
        </option>
      ))}
    </select>
  );
}
