import type { EnvironmentId, WorkjetWorkerProfile } from "@workjet/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { useActiveBusinessOsSettingsEnvironment } from "../settings/businessOsSettingsScope";
import { WorkjetWorkerEditor, type WorkjetWorkerDraft } from "../settings/WorkjetWorkerEditor";

interface WorkerProfilePopupEditorProps {
  readonly environmentId: EnvironmentId;
  readonly workerId: string | null;
  readonly draft?: WorkjetWorkerDraft | undefined;
  readonly onDraftChange: (draft: WorkjetWorkerDraft) => void;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onSaved: (worker: WorkjetWorkerProfile) => void;
  readonly onCancel: () => void;
}

/** Shares the Settings page's authority resolution and server command. */
export function WorkerProfilePopupEditor(props: WorkerProfilePopupEditorProps) {
  const target = useActiveBusinessOsSettingsEnvironment();
  if (target.phase !== "ready" || target.environment.environmentId !== props.environmentId) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {target.phase === "resolving"
          ? "Instanz wird geprüft …"
          : "Luma-Einstellungen nicht verfügbar"}
      </p>
    );
  }
  return <ScopedWorkerProfilePopupEditor key={target.environment.environmentId} {...props} />;
}

function ScopedWorkerProfilePopupEditor(props: WorkerProfilePopupEditorProps) {
  const configuration = useEnvironmentSettings(props.environmentId).workjet;
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const worker = configuration.workerProfiles.find((item) => item.id === props.workerId) ?? null;
  const computers = configuration.computers.filter(
    (computer) => computer.environmentId === props.environmentId,
  );
  if (
    props.workerId !== null &&
    (worker === null || !computers.some((computer) => computer.id === worker.computerId))
  ) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        Luma nicht mehr verfügbar
      </p>
    );
  }
  return (
    <div>
      <WorkjetWorkerEditor
        compact
        worker={worker}
        draftScopeKey={props.environmentId}
        initialDraft={props.draft}
        onDraftChange={props.onDraftChange}
        computers={computers}
        routes={configuration.llmRoutes}
        onCancel={props.onCancel}
        onSave={async (next) => {
          if (!computers.some((computer) => computer.id === next.computerId)) {
            throw new Error("Rechner der aktiven Instanz wählen");
          }
          const exists = configuration.workerProfiles.some((item) => item.id === next.id);
          props.onSavingChange(true);
          try {
            const result = await save({
              environmentId: props.environmentId,
              input: {
                patch: {
                  workjet: {
                    ...configuration,
                    workerProfiles: exists
                      ? configuration.workerProfiles.map((item) =>
                          item.id === next.id ? next : item,
                        )
                      : [...configuration.workerProfiles, next],
                  },
                },
              },
            });
            if (result._tag !== "Success") {
              throw new Error("Luma nicht gespeichert");
            }
            props.onSaved(next);
          } finally {
            props.onSavingChange(false);
          }
        }}
      />
    </div>
  );
}
