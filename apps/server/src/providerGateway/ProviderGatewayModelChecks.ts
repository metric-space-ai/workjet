import {
  WorkjetGatewayAccountId,
  WorkjetGatewayModelCheck,
  type WorkjetGatewayModelCheckInput,
  type WorkjetGatewayModelChecks,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

export const MODEL_CHECK_COOLDOWN_MS = 5 * 60_000;
const Persisted = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  entries: Schema.Array(Schema.Struct({ revision: Schema.String, check: WorkjetGatewayModelCheck })),
});
export interface ModelCheckTarget {
  readonly accountId: string;
  readonly modelId: string;
  /** A server-only digest of account configuration and credentials. */
  readonly revision: string;
}
export interface ModelChecksOptions {
  readonly now: () => number;
  readonly targets: () => Promise<ReadonlyArray<ModelCheckTarget>>;
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
  readonly probe: (target: ModelCheckTarget) => Promise<Pick<WorkjetGatewayModelCheck, "status" | "errorClass" | "httpStatus">>;
}

/** Serial transport, per-target coalescing and a durable credential-sensitive cooldown. */
export const makeModelChecks = (options: ModelChecksOptions) => {
  const entries = new Map<string, { revision: string; check: WorkjetGatewayModelCheck }>();
  const flights = new Map<string, Promise<void>>();
  const forced = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let loaded: Promise<void> | undefined;
  const key = (target: Pick<ModelCheckTarget, "accountId" | "modelId">) => JSON.stringify([target.accountId, target.modelId]);
  const load = () => loaded ??= (async () => {
    const raw = await options.read();
    if (raw === null) return;
    try {
      const decoded = Schema.decodeUnknownSync(Persisted)(JSON.parse(raw));
      for (const entry of decoded.entries) entries.set(key(entry.check), entry);
    } catch { /* Invalid observations are discarded; never promote corrupt data to green. */ }
  })();
  const reconcile = async () => {
    await load();
    const targets = await options.targets();
    const revisions = new Map(targets.map((target) => [key(target), target.revision]));
    for (const [id, entry] of entries) {
      if (revisions.get(id) !== entry.revision) entries.delete(id);
    }
    return targets;
  };
  const snapshot = (): WorkjetGatewayModelChecks => ({ schemaVersion: 1, checks: [...entries.values()].map((entry) => entry.check) });
  const list = async () => { await reconcile(); return snapshot(); };
  const run = async (input: WorkjetGatewayModelCheckInput) => {
    const targets = (await reconcile()).filter((target) =>
      (input.accountId === undefined || target.accountId === input.accountId) &&
      (input.modelId === undefined || target.modelId === input.modelId));
    await Promise.all(targets.map((target) => {
      const id = key(target);
      const flightKey = JSON.stringify([id, target.revision]);
      if (input.force) forced.add(flightKey);
      const existing = flights.get(flightKey);
      if (existing !== undefined) return existing;
      const flight = queue.then(async () => {
        // Recheck after queue admission: another command may have just tested it.
        const previous = entries.get(id);
        if (!forced.has(flightKey) && previous?.revision === target.revision &&
            options.now() - previous.check.checkedAtMs < MODEL_CHECK_COOLDOWN_MS) return;
        // Config edits during a queued request must never publish old greens.
        const current = await options.targets();
        if (!current.some((item) => key(item) === id && item.revision === target.revision)) return;
        const startedAt = options.now();
        const result = await options.probe(target).catch(() => ({
          status: "error" as const, errorClass: "network-provider" as const, httpStatus: null,
        }));
        const check: WorkjetGatewayModelCheck = {
          accountId: WorkjetGatewayAccountId.make(target.accountId), modelId: target.modelId,
          ...result, checkedAtMs: options.now(), latencyMs: Math.max(0, options.now() - startedAt),
        };
        const latest = await options.targets();
        if (!latest.some((item) => key(item) === id && item.revision === target.revision)) return;
        entries.set(id, { revision: target.revision, check });
        await options.write(JSON.stringify({ schemaVersion: 1, entries: [...entries.values()] }));
      });
      queue = flight.catch(() => undefined);
      flights.set(flightKey, flight);
      void flight.finally(() => { if (flights.get(flightKey) === flight) { flights.delete(flightKey); forced.delete(flightKey); } }).catch(() => undefined);
      return flight;
    }));
    await reconcile();
    return snapshot();
  };
  return { list, run };
};
