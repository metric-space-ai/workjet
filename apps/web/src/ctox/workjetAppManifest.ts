import {
  CTOX_APPROVAL_REQUESTS,
  CTOX_MAINTENANCE_RESTART,
  WORKJET_LUMA_STATE,
  WORKJET_MAILBOX_ENVELOPES,
} from "@workjet/shared/ctoxV4AppData";
import { PROJECT_READ_COLLECTIONS } from "./projectReadData";
import { THREAD_READ_COLLECTIONS } from "./threadReadAtoms";

/**
 * Workjet app manifest (app_id `workjet`) as the Shell/Core activates it (§9, E35 Nr. 3).
 * Ownership follows E42.3: until `store_workjet_projects.rs` is retired after M7, the project,
 * KPI, feed and worker-profile collections stay ctox-owned and Workjet reads them through the
 * K-WJ-1 exports. Workjet owns only its mailbox envelopes and the Luma state.
 * `workjet.worker.dispatch` is not part of this manifest until the Core decides its shape.
 */
export const WORKJET_APP_ID = "workjet";
/** E42.3: the only Workjet-owned collections. */
export const WORKJET_OWNED_COLLECTIONS = [WORKJET_MAILBOX_ENVELOPES, WORKJET_LUMA_STATE] as const;
/** E42.3: ctox-owned Workjet data read through the K-WJ-1 exports. */
export const WORKJET_CTOX_EXPORT_READS = [
  "workjet_projects",
  "workjet_project_kpis",
  "workjet_project_feed",
  "workjet_worker_profiles",
  CTOX_APPROVAL_REQUESTS,
] as const;
/** Projections behind the Scheibe C gated consumers (state/server, state/threads). */
export const SCHEIBE_C_READ_COLLECTIONS = [
  "workjet_connections",
  "workjet_calendar_accounts",
  "workjet_calendar_events",
  "workjet_gateway_state",
  "workjet_gateway_accounts",
  "workjet_gateway_pools",
  "workjet_gateway_routes",
  "workjet_gateway_models",
  "workjet_gateway_provider_models",
  "workjet_gateway_provider_pools",
  "workjet_gateway_provider_health",
  "workjet_gateway_account_health",
  "workjet_gateway_model_checks",
  "workjet_gateway_pending_checks",
  "workjet_gateway_model_discovery",
  "workjet_gateway_account_models",
  "workjet_llm_routes",
  "workjet_model_prompts",
] as const;
const OWNED = new Set<string>(WORKJET_OWNED_COLLECTIONS);
/** Read-only collections of other owners: app ctox (K-WJ-1) and platform (§16.41/§16.43). */
export const WORKJET_FOREIGN_COLLECTIONS = [
  ...new Set(
    [
      ...WORKJET_CTOX_EXPORT_READS,
      ...THREAD_READ_COLLECTIONS,
      "workjet_computers",
      "workjet_sessions",
      "workjet_session_transfers",
      "workjet_session_transfer_events",
      "workjet_provider_accounts",
      "workjet_provider_selections",
      "workjet_calendar_state",
      "devices",
      "machine_enrollments",
      ...SCHEIBE_C_READ_COLLECTIONS,
      ...Object.values(PROJECT_READ_COLLECTIONS),
    ].filter((collection) => !OWNED.has(collection)),
  ),
];
export const PLATFORM_OWNED = new Set(["devices", "machine_enrollments"]);
/**
 * `threads.ctox_approval.request` is a Core platform route and needs no entry. The restart has no
 * Core route yet and stays here behind the `hello_ok` capability check.
 */
export const WORKJET_COMMANDS_OUT = [CTOX_MAINTENANCE_RESTART] as const;

export function workjetAppManifest(appVer: string) {
  return {
    app_id: WORKJET_APP_ID,
    app_ver: appVer,
    title: "Workjet",
    min_app_api: "4.0",
    entry: "index.js",
    collections: Object.fromEntries(
      WORKJET_OWNED_COLLECTIONS.map((collection) => [collection, { class: "eager" }]),
    ),
    foreign_collections: Object.fromEntries(
      WORKJET_FOREIGN_COLLECTIONS.map((collection) => [
        collection,
        { owner_app: PLATFORM_OWNED.has(collection) ? "ctox-platform" : "ctox", ops: ["read"] },
      ]),
    ),
    handlers: {},
    commands_in: [],
    commands_out: [...WORKJET_COMMANDS_OUT],
    triggers: [],
  };
}

/** Fake-core seed for the owners of the foreign reads: declared and exported for read (K-WJ-1). */
export function workjetForeignOwnerManifests(appVer: string) {
  const byOwner = new Map<string, string[]>();
  for (const collection of WORKJET_FOREIGN_COLLECTIONS) {
    const owner = PLATFORM_OWNED.has(collection) ? "ctox-platform" : "ctox";
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), collection]);
  }
  return [...byOwner].map(([owner, collections]) => ({
    id: `${owner}@${appVer}`,
    app_id: owner,
    app_ver: appVer,
    manifest: {
      app_id: owner,
      app_ver: appVer,
      min_app_api: "4.0",
      collections: Object.fromEntries(collections.map((name) => [name, { class: "eager" }])),
      exports: Object.fromEntries(collections.map((name) => [name, ["read"]])),
      handlers: {},
    },
  }));
}
