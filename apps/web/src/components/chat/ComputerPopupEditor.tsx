import type { EnvironmentId, WorkjetComputer } from "@workjet/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useActiveBusinessOsSettingsEnvironment } from "../settings/businessOsSettingsScope";
import { workjetEnvironmentTargetOptions } from "../settings/workjetEnvironmentTargetOptions";
import {
  WorkjetComputerEditor,
  type WorkjetComputerDraft,
  type WorkjetEnvironmentTargetOption,
} from "../settings/WorkjetComputerEditor";

interface ComputerPopupEditorProps {
  readonly environmentId: EnvironmentId;
  readonly computerId: string;
  readonly draft?: WorkjetComputerDraft | undefined;
  readonly onDraftChange: (draft: WorkjetComputerDraft) => void;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

/** The existing instance-settings authority is required before reading or editing. */
export function ComputerPopupEditor(props: ComputerPopupEditorProps) {
  const target = useActiveBusinessOsSettingsEnvironment();
  if (target.phase !== "ready" || target.environment.environmentId !== props.environmentId) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {target.phase === "resolving"
          ? "Checking the active instance…"
          : "Computer settings are unavailable for this instance. Check the instance selection in Settings."}
      </p>
    );
  }
  return (
    <ScopedComputerPopupEditor
      key={target.environment.environmentId}
      {...props}
      environments={workjetEnvironmentTargetOptions([target.environment])}
    />
  );
}

function ScopedComputerPopupEditor(
  props: ComputerPopupEditorProps & {
    readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  },
) {
  const configuration = useEnvironmentSettings(props.environmentId).workjet;
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const computer =
    configuration.computers.find(
      (item) => item.id === props.computerId && item.environmentId === props.environmentId,
    ) ?? null;
  const inspection = useEnvironmentQuery(
    computer === null
      ? null
      : serverEnvironment.workjetHarnessInspect({
          environmentId: computer.environmentId,
          input: {},
        }),
  );
  if (computer === null) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        This computer is no longer available in the active instance.
      </p>
    );
  }
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Saved computer settings · These defaults are shared by workers using this computer. Saving
        does not move this chat.
      </p>
      {inspection.error ? (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          The host could not be checked. Saved settings remain available.
        </p>
      ) : null}
      <WorkjetComputerEditor
        compact
        computer={computer}
        environments={props.environments}
        initialDraft={props.draft}
        onDraftChange={props.onDraftChange}
        availability={inspection.error === null ? inspection.data : null}
        onCancel={props.onCancel}
        onSave={async (next: WorkjetComputer) => {
          if (next.id !== computer.id || next.environmentId !== computer.environmentId) {
            throw new Error("Keep the computer assigned to its current instance and connection.");
          }
          props.onSavingChange(true);
          try {
            const result = await save({
              environmentId: props.environmentId,
              input: {
                patch: {
                  workjet: {
                    ...configuration,
                    computers: configuration.computers.map((item) =>
                      item.id === computer.id ? next : item,
                    ),
                  },
                },
              },
            });
            if (result._tag !== "Success")
              throw new Error(
                "The computer could not be saved. Your changes are still here; check the connection and try again.",
              );
            props.onSaved();
          } finally {
            props.onSavingChange(false);
          }
        }}
      />
    </div>
  );
}
