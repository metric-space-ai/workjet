import type { CtoxAppApi } from "./ctoxClient";
import { createStubKernel } from "./stub-e51/ctox-app-api-stub.mjs";
import type { PreferencesApi } from "./stub-e51/index";

/**
 * The real E51 `api.prefs` from the pinned CTOX Sync v4 stub (stub-e51, 93a322c8) grafted onto a
 * fake-core client, until the pinned kernel ships `prefs` itself (ctox #912). The stub binds app
 * and user from the API context: prefs of `api.app.id` for `api.actor.id`. `prefsOf(appId)` reads
 * another app's prefs for the same user, to prove the per-app scope; `close` ends the stub.
 */
export async function withStubAppPrefs(api: CtoxAppApi): Promise<{
  readonly api: CtoxAppApi;
  readonly prefsOf: (appId: string) => PreferencesApi;
  readonly close: () => Promise<void>;
}> {
  const kernel = createStubKernel({
    instanceId: `prefs-${api.app.id}-${api.actor.id}`,
    userId: api.actor.id,
    storage: "memory",
  });
  await kernel.ready;
  const prefs = kernel.appApi(api.app.id, api.app.ver).prefs;
  return {
    api: Object.create(api, { prefs: { value: prefs, enumerable: true } }) as CtoxAppApi,
    prefsOf: (appId) => kernel.appApi(appId, api.app.ver).prefs,
    close: async () => {
      await kernel.close();
    },
  };
}
