import type { CtoxAppApi } from "./ctoxClient";
import type { PreferencesApi } from "./kernel/index";
import { CtoxLocalReadError } from "./projectReadData";

/**
 * Per-user UI state of the calling app (E51), as the pinned kernel ships it (ctox #912,
 * `kernel/index.d.ts`): `get(key)` answers the JSON value or `null` synchronously, `set` and
 * `delete` answer a write handle (`local`, `result`), and an invalid key or an oversized value
 * throws a `CtoxError` (`invalid` | `quota`) before anything is written. Always for the signed-in
 * user and the calling app; stored by the platform in `app_user_preferences`, never as app data.
 * A kernel without `prefs` (before #912) has no V4 gallery order and gets no collection fallback.
 */
export type CtoxAppPrefs = PreferencesApi;
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

export function readAppPref(api: CtoxAppApi, key: string): unknown {
  return prefsOf(api, key).get(key) ?? null;
}

export async function writeAppPref(api: CtoxAppApi, key: string, value: unknown): Promise<void> {
  const prefs = prefsOf(api, key);
  let handle: ReturnType<CtoxAppPrefs["set"]>;
  try {
    handle = prefs.set(key, value);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new CtoxLocalReadError(
      typeof code === "string" && code ? code : "invalid",
      "pref_write_rejected",
      key,
    );
  }
  await handle.local;
  const result = await handle.result;
  if (result.status === "rejected")
    throw new CtoxLocalReadError(result.code ?? "rejected", "pref_write_rejected", key);
}
