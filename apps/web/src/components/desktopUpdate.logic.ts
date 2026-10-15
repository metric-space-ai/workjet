import type { DesktopUpdateActionResult, DesktopUpdateState } from "@workjet/contracts";
import { isWindowsPlatform } from "../lib/utils";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_TAG_URL = "https://github.com/metric-space-ai/workjet/releases/tag";

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "Richtige Architektur";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "Intel-Build unter Rosetta · Update lädt Apple Silicon";
  }
  if (action === "install") {
    return "Intel-Build unter Rosetta · Neustart installiert Apple Silicon";
  }
  return "Intel-Build unter Rosetta · nächstes Update bringt Apple Silicon";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return state.availableVersion
      ? `Update ${state.availableVersion} herunterladen`
      : "Update herunterladen";
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Update wird geladen${progress}`;
  }
  if (state.status === "downloaded") {
    const version = state.downloadedVersion ?? state.availableVersion;
    return `Update${version ? ` ${version}` : ""} geladen · Neustart zum Installieren`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download von ${state.availableVersion} fehlgeschlagen · Erneut versuchen`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Installation von ${state.downloadedVersion} fehlgeschlagen · Erneut versuchen`;
    }
    return state.message ?? "Update fehlgeschlagen";
  }
  return "Aktuell";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  platform = "",
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const windowsInstallWarning = isWindowsPlatform(platform)
    ? "\n\nUnter Windows bleibt Workjet einige Minuten geschlossen, ohne Installationsfenster, und startet danach neu."
    : "";
  return `Update${version ? ` ${version}` : ""} installieren und Workjet neu starten?\n\nLaufende Aufgaben werden unterbrochen.${windowsInstallWarning}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}
