import {
  CTOX_APPROVAL_REQUEST,
  CTOX_APPROVAL_REQUESTS,
  CTOX_MAINTENANCE_RESTART,
  WORKJET_LUMA_STATE,
  WORKJET_MAILBOX_ENVELOPES,
  WORKJET_WORKER_DISPATCH,
} from "@workjet/shared/ctoxV4AppData";
import { PROJECT_READ_COLLECTIONS } from "./projectReadData";
import { THREAD_READ_COLLECTIONS } from "./threadReadAtoms";

/**
 * Workjet app manifest (app_id `workjet`) as the Shell/Core activates it (§9, E35 Nr. 3).
 * Workjet data stays Core/ctox-app owned (K-WJ-1, E49.4); Workjet declares what it reads and
 * which Core platform routes it sends (E40: platform routes need no app handler). Workjet has no
 * own command handlers yet: `workjet.worker.dispatch` (E49.5) is sent by Workjet and runs in the
 * Workjet app handler on the instance (`process.run`); that handler ships with the instance-side
 * app artifact, so this manifest names it in `commands_out` only.
 */
export const WORKJET_APP_ID = "workjet";
/** Workjet-owned collections (proposals docs/v4/workjet-collections{,-b}.json). */
export const WORKJET_OWNED_COLLECTIONS = [
  "workjet_projects",
  "workjet_project_kpis",
  "workjet_project_feed",
  "workjet_worker_profiles",
  // Slice C (E49.4): mailbox envelopes and the Luma/preset configuration are Workjet app data.
  WORKJET_MAILBOX_ENVELOPES,
  WORKJET_LUMA_STATE,
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
  // decision_hub.* → threads.ctox_approval.request; Workjet reads the projected approval (E49.4).
  CTOX_APPROVAL_REQUESTS,
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
    commands_out: [CTOX_APPROVAL_REQUEST, CTOX_MAINTENANCE_RESTART, WORKJET_WORKER_DISPATCH],
    triggers: [],
  };
}
