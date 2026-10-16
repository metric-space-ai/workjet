import {
  DEFAULT_SERVER_SETTINGS,
  type EditorId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  type ServerProvider,
  type ServerSettings,
} from "@workjet/contracts";
import { createServerEnvironmentAtoms } from "@workjet/client-runtime/state/server";
import { createEnvironmentServerConfigsAtom } from "@workjet/client-runtime/state/shell";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@workjet/shared/keybindings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";
import { ctoxLumaReads } from "../ctox/lumaReadData";
import { ctoxGatewayReads } from "../ctox/gatewayReadData";
import { ctoxCalendarReads } from "../ctox/calendarReadData";
import { gateCtoxReadFamily } from "../ctox/v4GatedAtoms";

const legacyServerEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
});
const gated = <K extends keyof typeof legacyServerEnvironment & keyof typeof v4Reads>(key: K) =>
  gateCtoxReadFamily(
    legacyServerEnvironment[key] as (input: unknown) => Atom.Atom<unknown>,
    v4Reads[key] as (input: unknown) => Atom.Atom<unknown>,
  ) as unknown as (typeof legacyServerEnvironment)[K];
const v4Reads = {
  lumaConfiguration: ctoxLumaReads.lumaConfiguration,
  calendarAccounts: ctoxCalendarReads.calendarAccounts,
  ...ctoxGatewayReads,
};
/**
 * Scheibe C: Luma, calendar accounts and gateway reads come from the local kernel on a V4
 * instance (bound kernel client) and from the unchanged environment RPC on V3.
 */
export const serverEnvironment = {
  ...legacyServerEnvironment,
  lumaConfiguration: gated("lumaConfiguration"),
  calendarAccounts: gated("calendarAccounts"),
  workjetGatewayStatus: gated("workjetGatewayStatus"),
  workjetGatewayCatalog: gated("workjetGatewayCatalog"),
  workjetGatewayHealth: gated("workjetGatewayHealth"),
  workjetGatewayModelChecks: gated("workjetGatewayModelChecks"),
  workjetGatewayModels: gated("workjetGatewayModels"),
  workjetGatewayAccountModels: gated("workjetGatewayAccountModels"),
};
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

interface PrimaryServerState {
  readonly config: ServerConfig | null;
  readonly latestEvent: ServerConfigStreamEvent | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];
export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const EMPTY_PRIMARY_SERVER_STATE: PrimaryServerState = {
  config: null,
  latestEvent: null,
  welcome: null,
};

export const primaryServerStateAtom = Atom.make((get): PrimaryServerState => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_PRIMARY_SERVER_STATE;
  }

  const target = { environmentId, input: {} };
  const configProjection = Option.getOrNull(
    AsyncResult.value(get(serverEnvironment.configProjection(target))),
  );
  const welcome = Option.getOrNull(AsyncResult.value(get(serverEnvironment.welcome(target))));

  return {
    config: get(serverEnvironment.configValueAtom(environmentId)),
    latestEvent: configProjection?.latestEvent ?? null,
    welcome,
  };
}).pipe(Atom.withLabel("web-primary-server-state"));

export const primaryServerConfigAtom = Atom.make(
  (get): ServerConfig | null => get(primaryServerStateAtom).config,
).pipe(Atom.withLabel("web-primary-server-config"));

export const primaryServerConfigEventAtom = Atom.make(
  (get): ServerConfigStreamEvent | null => get(primaryServerStateAtom).latestEvent,
).pipe(Atom.withLabel("web-primary-server-config-event"));

export const primaryServerWelcomeAtom = Atom.make(
  (get): ServerLifecycleWelcomePayload | null => get(primaryServerStateAtom).welcome,
).pipe(Atom.withLabel("web-primary-server-welcome"));

export const primaryServerSettingsAtom = Atom.make(
  (get): ServerSettings => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
).pipe(Atom.withLabel("web-primary-server-settings"));

export const primaryServerProvidersAtom = Atom.make(
  (get): ReadonlyArray<ServerProvider> =>
    get(primaryServerConfigAtom)?.providers ?? EMPTY_SERVER_PROVIDERS,
).pipe(Atom.withLabel("web-primary-server-providers"));

export const primaryServerKeybindingsAtom = Atom.make(
  (get): ServerConfig["keybindings"] =>
    get(primaryServerConfigAtom)?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS,
).pipe(Atom.withLabel("web-primary-server-keybindings"));

export const primaryServerAvailableEditorsAtom = Atom.make(
  (get): ReadonlyArray<EditorId> =>
    get(primaryServerConfigAtom)?.availableEditors ?? EMPTY_AVAILABLE_EDITORS,
).pipe(Atom.withLabel("web-primary-server-available-editors"));

export const primaryServerKeybindingsConfigPathAtom = Atom.make(
  (get): string | null => get(primaryServerConfigAtom)?.keybindingsConfigPath ?? null,
).pipe(Atom.withLabel("web-primary-server-keybindings-config-path"));

export const primaryServerObservabilityAtom = Atom.make(
  (get): ServerConfig["observability"] | null =>
    get(primaryServerConfigAtom)?.observability ?? null,
).pipe(Atom.withLabel("web-primary-server-observability"));
