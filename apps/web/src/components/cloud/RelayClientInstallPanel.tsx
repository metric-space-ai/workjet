import { DownloadIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import type { RelayClientInstallProgressStage } from "@workjet/contracts";

import {
  completeRelayClientInstallPanelClose,
  readRelayClientInstallPanelState,
  respondToRelayClientInstallConfirmation,
  subscribeRelayClientInstallPanel,
} from "../../cloud/relayClientInstallPanel";
import { InlineConfirmBar, InlineNoticePortal, InlineNoticeRow } from "../InlineNoticeSlot";

export const RELAY_CLIENT_INSTALL_STEPS: ReadonlyArray<{
  readonly stage: RelayClientInstallProgressStage;
  readonly label: string;
}> = [
  { stage: "checking", label: "Prüfen" },
  { stage: "waiting_for_lock", label: "Warten" },
  { stage: "downloading", label: "Herunterladen" },
  { stage: "verifying", label: "Verifizieren" },
  { stage: "installing", label: "Installieren" },
  { stage: "validating", label: "Validieren" },
  { stage: "activating", label: "Aktivieren" },
];

/**
 * Relay-Client-Installation ohne Modal: erst eine Inline-Bestätigung
 * („Relay-Client 1.2.3 installieren? [Installieren] [Abbrechen]“), danach eine
 * Fortschrittszeile mit Schritt und Balken, beides unter dem Kopf. Der
 * Zustand kommt unverändert aus `cloud/relayClientInstallPanel`.
 *
 * Selbstständig: die Komponente kann global (heute `__root.tsx`) oder im
 * Abschnitt Workjet Connect von Einstellungen › Instanzen eingehängt werden.
 */
export function RelayClientInstallPanel() {
  const state = useSyncExternalStore(
    subscribeRelayClientInstallPanel,
    readRelayClientInstallPanelState,
    readRelayClientInstallPanelState,
  );

  // Ohne Ausblend-Animation ist der Abschluss sofort erreicht.
  useEffect(() => {
    if (state.status === "closing") completeRelayClientInstallPanelClose();
  }, [state]);

  if (state.status === "confirming") {
    return (
      <InlineNoticePortal>
        <InlineConfirmBar
          confirmLabel="Installieren"
          markers={{
            row: "relay-client-install",
            confirm: "relay-client-install-confirm",
            cancel: "relay-client-install-cancel",
          }}
          question={`Relay-Client ${state.version} installieren?`}
          onCancel={() => respondToRelayClientInstallConfirmation(false)}
          onConfirm={() => respondToRelayClientInstallConfirmation(true)}
        />
      </InlineNoticePortal>
    );
  }

  if (state.status !== "installing") return null;

  const activeStepIndex = Math.max(
    0,
    RELAY_CLIENT_INSTALL_STEPS.findIndex(({ stage }) => stage === state.stage),
  );
  const activeStep = RELAY_CLIENT_INSTALL_STEPS[activeStepIndex];
  const line = `Relay-Client ${state.version} · ${activeStep?.label ?? "Prüfen"}`;

  return (
    <InlineNoticePortal>
      <InlineNoticeRow
        data-relay-client-install-progress=""
        actions={
          <span className="text-xs text-muted-foreground tabular-nums">
            {activeStepIndex + 1}/{RELAY_CLIENT_INSTALL_STEPS.length}
          </span>
        }
        icon={DownloadIcon}
        label={line}
      >
        <span aria-live="polite" className="min-w-0 shrink truncate" title={line}>
          {line}
        </span>
        <progress
          aria-label="Fortschritt"
          className="h-1.5 w-full min-w-16 max-w-48 flex-1 appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
          max={RELAY_CLIENT_INSTALL_STEPS.length}
          value={activeStepIndex + 1}
        />
      </InlineNoticeRow>
    </InlineNoticePortal>
  );
}
