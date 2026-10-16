import { PROJECT_READ_COLLECTIONS } from "./projectReadData";
import { THREAD_READ_COLLECTIONS } from "./threadReadAtoms";

/**
 * Workjet app manifest (app_id `workjet`) as the Shell/Core activates it (§9, E35 Nr. 3).
 * Workjet data stays Core/ctox-app owned (K-WJ-1, E49.4); Workjet declares what it reads and
 * which Core platform routes it sends (E40: platform routes need no app handler). Workjet has no
 * own command handlers yet; `workjet_worker_dispatch` arrives with slice C (E49.5).
 */
export const WORKJET_APP_ID = "workjet";
/** Workjet-owned collections (proposals docs/v4/workjet-collections{,-b}.json). */
export const WORKJET_OWNED_COLLECTIONS = [
  "workjet_projects",
  "workjet_project_kpis",
  "workjet_project_feed",
  "workjet_worker_profiles",
  ...THREAD_READ_COLLECTIONS,
] as const;
/** Read-only collections of other owners: app ctox (K-WJ-1) and platform (§16.41/§16.43). */
export const WORKJET_FOREIGN_COLLECTIONS = [
  "workjet_computers",
  "workjet_sessions",
  "workjet_session_transfers",
  "workjet_session_transfer_events",
  "workjet_provider_accounts",
  "workjet_provider_selections",
  "workjet_calendar_state",
  "devices",
  "machine_enrollments",
  ...new Set(Object.values(PROJECT_READ_COLLECTIONS)),
] as const;
export const PLATFORM_OWNED = new Set(["devices", "machine_enrollments"]);

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
      [...new Set(WORKJET_FOREIGN_COLLECTIONS)].map((collection) => [
        collection,
        { owner_app: PLATFORM_OWNED.has(collection) ? "ctox-platform" : "ctox", ops: ["read"] },
      ]),
    ),
    handlers: {},
    commands_in: [],
    commands_out: [],
    triggers: [],
  };
}
