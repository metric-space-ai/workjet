import * as Schema from "effect/Schema";
import { PublicModelCatalog, decodePublicModelCatalog } from "./LiveProviderCatalog.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETRY_MS = 60_000;
const Cache = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  savedAtMs: Schema.Number,
  catalog: PublicModelCatalog,
});
const decodeCache = Schema.decodeUnknownSync(Cache);

export function makePublicModelCatalogCache(io: {
  readonly now: () => number;
  readonly read: () => Promise<string>;
  readonly write: (value: string) => Promise<void>;
  readonly fetch: () => Promise<unknown>;
}) {
  let catalog: typeof PublicModelCatalog.Type | undefined;
  let loaded: Promise<void> | undefined;
  let flight: Promise<void> | undefined;
  let nextRefreshAtMs = 0;

  const load = () => {
    loaded ??= (async () => {
      try {
        const saved = decodeCache(JSON.parse(await io.read()));
        const now = io.now();
        if (!Number.isFinite(saved.savedAtMs) || saved.savedAtMs > now + 5_000 ||
            saved.savedAtMs < Date.parse(saved.catalog.checkedAt)) return;
        catalog = decodePublicModelCatalog(saved.catalog, now, true);
      } catch {
        // Missing/corrupt cache never falls back to an invented/static model list.
      }
    })();
    return loaded;
  };

  const refresh = async (): Promise<void> => {
    await load();
    if (flight !== undefined) return flight;
    flight = (async () => {
      nextRefreshAtMs = io.now() + RETRY_MS;
      try {
        const observed = decodePublicModelCatalog(await io.fetch(), io.now());
        if (observed === undefined) return;
        catalog = observed;
        nextRefreshAtMs = io.now() + DAY_MS;
        await io.write(JSON.stringify({
          schemaVersion: 1,
          savedAtMs: io.now(),
          catalog: observed,
        }) + "\n").catch(() => undefined);
      } catch {
        // Retain the original observation time; an outage is never a fresh observation.
      }
    })();
    try {
      await flight;
    } finally {
      flight = undefined;
    }
  };

  return {
    refresh,
    read: async () => {
      await load();
      if (io.now() >= nextRefreshAtMs) await refresh();
      return catalog === undefined ? undefined : decodePublicModelCatalog(catalog, io.now(), true);
    },
  };
}

