import type { CtoxAppApi } from "./ctoxClient";
import { CtoxLocalReadError } from "./projectReadData";

/**
 * Per-user UI state of the calling app (E51): `api.prefs.get(key)` → JSON | null,
 * `api.prefs.set(key, json)` → receipt, `api.prefs.delete(key)`. Always for the signed-in user and
 * the calling app; stored by the platform in `app_user_preferences`, never as app business data.
 * The pinned kernel (eca39cf84) does not type `prefs` yet, so the shape is declared here from the
 * E51 contract; get/set may answer synchronously or with a promise, the receipt may be a write
 * handle (`{ local, result }`) or a write result.
 */
export interface CtoxAppPrefs {
  get(key: string): unknown;
  set(key: string, value: unknown): unknown;
  delete(key: string): unknown;
}
type WithPrefs = CtoxAppApi & { readonly prefs?: CtoxAppPrefs };

/** E56.2: the Workjet gallery order is UI state of the app `workjet`. */
export const GALLERY_ORDER_PREF = "gallery.order";
const KEY = /^[a-z0-9._-]{1,64}$/;

function prefsOf(api: CtoxAppApi, key: string): CtoxAppPrefs {
  if (!KEY.test(key)) throw new CtoxLocalReadError("invalid", "pref_key_invalid", key);
  const prefs = (api as WithPrefs).prefs;
  // No fallback onto a collection: a kernel without api.prefs simply has no V4 gallery order yet.
  if (prefs === undefined) throw new CtoxLocalReadError("unavailable", "prefs_unavailable", key);
  return prefs;
}

export async function readAppPref(api: CtoxAppApi, key: string): Promise<unknown> {
  return (await prefsOf(api, key).get(key)) ?? null;
}

export async function writeAppPref(api: CtoxAppApi, key: string, value: unknown): Promise<void> {
  const receipt = (await prefsOf(api, key).set(key, value)) as
    | { readonly local?: Promise<void>; readonly result?: Promise<unknown> }
    | { readonly status?: string; readonly code?: string }
    | null
    | undefined;
  let result: unknown = receipt;
  if (receipt && typeof receipt === "object" && "result" in receipt && receipt.result) {
    await receipt.local;
    result = await receipt.result;
  }
  const status = (result as { status?: unknown } | null | undefined)?.status;
  if (status === "rejected") {
    const code = (result as { code?: unknown }).code;
    throw new CtoxLocalReadError(
      typeof code === "string" && code ? code : "rejected",
      "pref_write_rejected",
      key,
    );
  }
}
