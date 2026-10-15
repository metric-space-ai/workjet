import type { DesktopBridge, DesktopUpdateState } from "@workjet/contracts";

import {
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
import { toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

/** Öffnet die Versionshinweise; scheitert das, folgt ein einzeiliger Fehler-Toast. */
export function openDesktopUpdateReleaseNotes(shell: DesktopUpdateShell, releaseUrl: string): void {
  void (async () => {
    try {
      if (await shell.openExternal(releaseUrl)) return;
    } catch {
      // Surface rejected IPC calls through the same user-visible fallback.
    }
    toastManager.add({ type: "error", title: "Versionshinweise nicht geöffnet" });
  })();
}

/**
 * Toast nach dem Download (UI-Vertrag: eine Zeile, höchstens eine Aktion):
 * „Update 0.0.86 geladen · [Versionshinweise]“. Neu gestartet wird über den
 * Update-Chip, nicht aus dem Toast.
 */
export function showDesktopUpdateDownloadedToast(
  shell: DesktopUpdateShell,
  state: DesktopUpdateState,
): void {
  const version = getDesktopUpdateDownloadedVersion(state);
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  toastManager.add({
    type: "success",
    title: version ? `Update ${version} geladen` : "Update geladen",
    ...(releaseUrl
      ? {
          actionProps: {
            children: "Versionshinweise",
            onClick: () => openDesktopUpdateReleaseNotes(shell, releaseUrl),
          },
        }
      : {}),
  });
}
