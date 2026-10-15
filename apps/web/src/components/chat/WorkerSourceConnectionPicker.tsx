import { OptionSelect } from "../ui/option-select";
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
    <OptionSelect
      aria-label="Luma-Zugang wählen"
      className="w-auto max-w-full sm:max-w-64"
      value=""
      placeholder="Luma-Zugang wählen …"
      disabled={props.disabled}
      options={props.choice.connections.map((entry) => ({
        value: entry.connectionId,
        label: `${entry.displayName} · ${entry.connectionId.split(":").at(-1)?.slice(0, 8) ?? ""}`,
      }))}
      onValueChange={props.choice.select}
    />
  );
}
