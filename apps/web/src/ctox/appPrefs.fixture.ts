import type { CtoxAppApi } from "./ctoxClient";
import type { CtoxAppPrefs } from "./appPrefs";

/**
 * Test fake of `api.prefs` (E51) until the pinned kernel ships it: rows of the platform collection
 * `app_user_preferences` with id `<app_id>/<user_id>/<key>`, always for the client's own app and
 * actor; key ≤ 64 chars `[a-z0-9._-]`, value ≤ 16 KiB JSON, ≤ 64 keys per app and user (`quota`).
 * Returns a client that inherits the kernel API and adds `prefs`; `rows` exposes the stored rows.
 */
export function withFakeAppPrefs(
  api: CtoxAppApi,
  rows: Map<string, { readonly id: string; readonly value: unknown }> = new Map(),
): { readonly api: CtoxAppApi; readonly rows: typeof rows } {
  const prefix = `${api.app.id}/${api.actor.id}/`;
  const reject = (code: string) => ({
    local: Promise.resolve(),
    result: Promise.resolve({ status: "rejected", code }),
  });
  const prefs: CtoxAppPrefs = {
    get: (key) => {
      const row = rows.get(prefix + key);
      return row === undefined ? null : structuredClone(row.value);
    },
    set: (key, value) => {
      if (!/^[a-z0-9._-]{1,64}$/.test(key)) return reject("invalid");
      const encoded = JSON.stringify(value);
      if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 16_384)
        return reject("invalid");
      const own = [...rows.keys()].filter((id) => id.startsWith(prefix));
      if (!own.includes(prefix + key) && own.length >= 64) return reject("quota");
      rows.set(prefix + key, { id: prefix + key, value: JSON.parse(encoded) });
      return { local: Promise.resolve(), result: Promise.resolve({ status: "accepted" }) };
    },
    delete: (key) => {
      rows.delete(prefix + key);
      return { local: Promise.resolve(), result: Promise.resolve({ status: "accepted" }) };
    },
  };
  return { api: Object.create(api, { prefs: { value: prefs, enumerable: true } }), rows };
}
