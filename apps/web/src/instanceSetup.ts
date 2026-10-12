import type { CtoxManagedInstance } from "@workjet/contracts";

import { isElectron } from "./env";

/**
 * Instanz hinzufügen (drei Orte, keine Popups): Jeder Aufruf führt nach
 * Einstellungen › Instanzen und öffnet dort das Inline-Panel mit der
 * gewünschten Option. Es gibt keinen Dialog mehr.
 *
 * Neue Instanzen auf eigenen Rechnern (lokal, SSH, Tailscale) entstehen in
 * Einstellungen › Rechner; diese Absichten führen dorthin.
 */
export type InstanceSetupIntent =
  | "choose"
  | "create"
  | "connect"
  | "local"
  | "ssh"
  | "tailscale"
  | "managed"
  | "qr"
  | "link"
  | "manual";

/** Die vier Optionen im Segment des Inline-Panels. */
export type InstanceAddOption = "ctox-dev" | "link" | "qr" | "manual";

export const INSTANCES_SETTINGS_PATH = "/settings/business-os";
export const COMPUTERS_SETTINGS_PATH = "/settings/computers";
export type InstanceSetupPath = typeof INSTANCES_SETTINGS_PATH | typeof COMPUTERS_SETTINGS_PATH;

export interface InstanceSetupRequest {
  readonly intent: InstanceSetupIntent;
  readonly option: InstanceAddOption;
  readonly revision: number;
  readonly replacesInstanceId?: string;
  /** Vorbelegter Einladungslink, z. B. aus einem workjet://pair-Link. */
  readonly invite?: string;
}

export function instanceAddOptionForIntent(intent: InstanceSetupIntent): InstanceAddOption {
  switch (intent) {
    case "qr":
      return "qr";
    case "link":
    case "connect":
      return "link";
    case "manual":
      return "manual";
    default:
      return "ctox-dev";
  }
}

/** Absichten, die neue Rechner anlegen, gehören nach Einstellungen › Rechner. */
export function instanceSetupPathForIntent(intent: InstanceSetupIntent): InstanceSetupPath {
  return intent === "local" || intent === "ssh" || intent === "tailscale"
    ? COMPUTERS_SETTINGS_PATH
    : INSTANCES_SETTINGS_PATH;
}

let current: InstanceSetupRequest | null = null;
let revision = 0;
const listeners = new Set<() => void>();
const navigators: Array<(path: InstanceSetupPath) => void> = [];

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Router-Navigation registrieren. Die Kopfzeile und die Instanzen-Seite
 * melden sich hier an; ohne Anmeldung führt ein History-Wechsel hin.
 */
export function registerInstanceSetupNavigator(
  next: (path: InstanceSetupPath) => void,
): () => void {
  navigators.push(next);
  return () => {
    const index = navigators.lastIndexOf(next);
    if (index !== -1) navigators.splice(index, 1);
  };
}

function navigateTo(path: InstanceSetupPath) {
  const navigate = navigators.at(-1);
  if (navigate !== undefined) {
    navigate(path);
    return;
  }
  if (typeof window === "undefined") return;
  const location = window.location;
  if (isElectron) {
    // Hash-Routing (Desktop): der Router folgt dem hashchange.
    if (location.hash.split("?")[0] !== `#${path}`) location.hash = `#${path}`;
    return;
  }
  if (location.pathname === path) return;
  window.history.pushState(window.history.state, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

/** Panel-Zustand setzen, ohne zu navigieren (die Seite selbst ruft das auf). */
export function requestInstanceAdd(
  option: InstanceAddOption,
  details: { readonly replacesInstanceId?: string; readonly invite?: string } = {},
  intent: InstanceSetupIntent = option === "ctox-dev" ? "managed" : option,
) {
  current = {
    intent,
    option,
    revision: ++revision,
    ...(details.replacesInstanceId === undefined
      ? {}
      : { replacesInstanceId: details.replacesInstanceId }),
    ...(details.invite === undefined ? {} : { invite: details.invite }),
  };
  notify();
}

/**
 * Öffnet das Hinzufügen inline: Anfrage im Store ablegen, dann navigieren.
 * Rechner-Absichten (lokal, SSH, Tailscale) bleiben als Anfrage lesbar,
 * damit Einstellungen › Rechner die passende Art vorwählen kann; die
 * Instanzen-Seite ignoriert sie (`isInstancesPageRequest`).
 */
export function openInstanceSetup(
  intent: InstanceSetupIntent = "choose",
  replacesInstanceId?: string,
) {
  requestInstanceAdd(
    instanceAddOptionForIntent(intent),
    replacesInstanceId === undefined ? {} : { replacesInstanceId },
    intent,
  );
  navigateTo(instanceSetupPathForIntent(intent));
}

export function isInstancesPageRequest(
  request: InstanceSetupRequest | null,
): request is InstanceSetupRequest {
  return request !== null && instanceSetupPathForIntent(request.intent) === INSTANCES_SETTINGS_PATH;
}

export function closeInstanceSetup() {
  if (current === null) return;
  current = null;
  notify();
}

export function openInstanceRePair(instance: Pick<CtoxManagedInstance, "id" | "source">) {
  if (instance.source === "pairing_invite" || instance.source === "manual_pairing")
    openInstanceSetup("link", instance.id);
  else openInstanceSetup(instance.source === "ctox_dev" ? "managed" : "choose");
}

/**
 * Suchparameter von Einstellungen › Instanzen: `?add=link&payload=…` kommt
 * aus einem workjet://pair-Link (Desktop-Deep-Link). Der Link wird nur
 * vorbelegt; importiert wird erst nach „Hinzufügen“.
 */
export function instanceAddRequestFromSearch(
  search: Readonly<Record<string, unknown>> | undefined,
): { readonly option: InstanceAddOption; readonly invite?: string } | null {
  if (search === undefined) return null;
  const add = search.add;
  const payload = search.payload;
  const option: InstanceAddOption | null =
    add === "ctox-dev" || add === "link" || add === "qr" || add === "manual" ? add : null;
  const validPayload =
    typeof payload === "string" && /^[A-Za-z0-9_-]{1,4096}$/.test(payload) ? payload : null;
  if (validPayload !== null) {
    return {
      option: "link",
      invite: `workjet://pair?${new URLSearchParams([["payload", validPayload]]).toString()}`,
    };
  }
  return option === null ? null : { option };
}

export const instanceSetupStore = {
  getSnapshot: () => current,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
