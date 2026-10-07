import {
  WorkjetGatewayAccountId,
  WorkjetGatewayModelCheck,
  type WorkjetGatewayModelCheckInput,
  type WorkjetGatewayModelChecks,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

export const MODEL_CHECK_COOLDOWN_MS = 5 * 60_000;
export const MODEL_CHECK_BATCH_LIMIT = 32;
export const MODEL_CHECK_QUEUE_LIMIT = 64;
const Persisted = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  entries: Schema.Array(
    Schema.Struct({ revision: Schema.String, check: WorkjetGatewayModelCheck }),
  ),
});
const decodePersisted = Schema.decodeUnknownSync(Persisted);
export interface ModelCheckTarget {
  readonly accountId: string;
  readonly modelId: string;
  readonly revision: string;
}
export interface ModelChecksOptions {
  readonly now: () => number;
  readonly targets: () => Promise<ReadonlyArray<ModelCheckTarget>>;
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
  readonly probe: (
    target: ModelCheckTarget,
    signal: AbortSignal,
  ) => Promise<
    Pick<
      WorkjetGatewayModelCheck,
      "status" | "errorClass" | "httpStatus" | "source" | "unavailableReason"
    >
  >;
}
interface PendingCheck {
  readonly target: ModelCheckTarget;
  force: boolean;
  status: "queued" | "running";
}

/** The service owns shutdown: bounded admission and a single cancellable pump. */
export const makeModelChecks = (options: ModelChecksOptions) => {
  const entries = new Map<string, { revision: string; check: WorkjetGatewayModelCheck }>();
  const pending = new Map<string, PendingCheck>();
  const admissions = new Map<string, { readonly revision: string; readonly order: number }>();
  let admissionOrder = 0;
  let pump: Promise<void> | undefined;
  let active: { readonly item: PendingCheck; readonly controller: AbortController } | undefined;
  let loaded: Promise<void> | undefined;
  let closed = false;
  let deferredCount = 0;
  const key = (target: Pick<ModelCheckTarget, "accountId" | "modelId">) =>
    JSON.stringify([target.accountId, target.modelId]);
  const fresh = (check: WorkjetGatewayModelCheck) => {
    const age = options.now() - check.checkedAtMs;
    return age >= 0 && age < MODEL_CHECK_COOLDOWN_MS;
  };
  const load = () =>
    (loaded ??= (async () => {
      const raw = await options.read();
      if (raw === null) return;
      try {
        const decoded = decodePersisted(JSON.parse(raw));
        for (const entry of decoded.entries) {
          const id = key(entry.check);
          entries.set(id, entry);
          admissions.set(id, { revision: entry.revision, order: ++admissionOrder });
        }
      } catch {
        /* Invalid observations never become green. */
      }
    })());
  const reconcile = async () => {
    await load();
    const targets = await options.targets();
    const revisions = new Map(targets.map((target) => [key(target), target.revision]));
    for (const [id, entry] of entries) {
      if (revisions.get(id) !== entry.revision) entries.delete(id);
    }
    for (const [id, admission] of admissions) {
      if (revisions.get(id) !== admission.revision) admissions.delete(id);
    }
    for (const [id, item] of pending) {
      if (revisions.get(id) !== item.target.revision) {
        pending.delete(id);
        if (active?.item === item) active.controller.abort();
      }
    }
    return targets;
  };
  const snapshot = (): WorkjetGatewayModelChecks => ({
    schemaVersion: 1,
    checks: [...entries.values()].map((entry) => entry.check),
    pending: [...pending.values()].map(({ target, status }) => ({
      accountId: WorkjetGatewayAccountId.make(target.accountId),
      modelId: target.modelId,
      status,
    })),
    deferredCount,
  });
  const list = async () => {
    await reconcile();
    return snapshot();
  };
  const captureRevisions = async () =>
    new Map((await reconcile()).map((target) => [key(target), target.revision]));
  const processQueue = async () => {
    while (pending.size > 0) {
      if (closed) break;
      const first = pending.entries().next().value;
      if (first === undefined) break;
      const [id, item] = first;
      await reconcile();
      if (pending.get(id) !== item) continue;
      const previous = entries.get(id);
      if (!item.force && previous?.revision === item.target.revision && fresh(previous.check)) {
        pending.delete(id);
        continue;
      }
      const controller = new AbortController();
      active = { item, controller };
      item.status = "running";
      const startedAt = options.now();
      const result = await options.probe(item.target, controller.signal).catch(() => ({
        status: "unavailable" as const,
        errorClass: null,
        httpStatus: null,
        source: "gateway" as const,
        unavailableReason: "transport" as const,
      }));
      await reconcile();
      // Shutdown and config replacement both discard results of the old request.
      if (!closed && !controller.signal.aborted && pending.get(id) === item) {
        const check: WorkjetGatewayModelCheck = {
          accountId: WorkjetGatewayAccountId.make(item.target.accountId),
          modelId: item.target.modelId,
          ...result,
          checkedAtMs: options.now(),
          latencyMs: Math.max(0, options.now() - startedAt),
        };
        entries.set(id, { revision: item.target.revision, check });
        try {
          await options.write(JSON.stringify({ schemaVersion: 3, entries: [...entries.values()] }));
        } catch {
          entries.delete(id);
        }
      }
      if (pending.get(id) === item) pending.delete(id);
      active = undefined;
    }
  };
  const kick = () => {
    if (pump !== undefined || closed || pending.size === 0) return;
    const running = processQueue().catch(() => {
      pending.clear();
    });
    pump = running;
    void running.finally(() => {
      if (pump === running) pump = undefined;
      active = undefined;
      kick();
    });
  };
  const admit = (targets: ReadonlyArray<ModelCheckTarget>, force: boolean) => {
    let admitted = 0;
    deferredCount = 0;
    if (closed) return snapshot();
    // Admission order is independent of wall time and the provider's own routing policy.
    // Unseen targets precede previously admitted targets even after their cooldown expires.
    const ordered = targets.toSorted(
      (left, right) =>
        (admissions.get(key(left))?.order ?? 0) - (admissions.get(key(right))?.order ?? 0),
    );
    for (const target of ordered) {
      const id = key(target);
      const existing = pending.get(id);
      if (existing?.target.revision === target.revision) {
        existing.force ||= force;
        continue;
      }
      const previous = entries.get(id);
      if (!force && previous?.revision === target.revision && fresh(previous.check)) continue;
      if (admitted >= MODEL_CHECK_BATCH_LIMIT || pending.size >= MODEL_CHECK_QUEUE_LIMIT) {
        deferredCount += 1;
        continue;
      }
      pending.set(id, { target, force, status: "queued" });
      admissions.set(id, { revision: target.revision, order: ++admissionOrder });
      admitted += 1;
    }
    const result = snapshot();
    kick();
    return result;
  };
  const schedule = async (input: WorkjetGatewayModelCheckInput) => {
    const targets = (await reconcile()).filter(
      (target) =>
        (input.accountId === undefined || target.accountId === input.accountId) &&
        (input.modelId === undefined || target.modelId === input.modelId),
    );
    return admit(targets, input.force === true);
  };
  const scheduleChanged = async (previous: ReadonlyMap<string, string>) =>
    admit(
      (await reconcile()).filter((target) => previous.get(key(target)) !== target.revision),
      false,
    );
  const drain = async () => {
    for (;;) {
      const current = pump;
      if (current === undefined) return;
      await current;
    }
  };
  const run = async (input: WorkjetGatewayModelCheckInput) => {
    await schedule(input);
    await drain();
    return list();
  };
  const cancel = async () => {
    pending.clear();
    active?.controller.abort();
    await drain();
  };
  const shutdown = async () => {
    closed = true;
    await cancel();
  };
  return { list, schedule, scheduleChanged, captureRevisions, drain, run, cancel, shutdown };
};
