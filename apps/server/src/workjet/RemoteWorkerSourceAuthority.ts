// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeUtil from "node:util";
import { RemoteWorkerDispatchError, type RemoteWorkerRequest } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { type RemoteWorkerAuthorityIntent, type RemoteWorkerAuthorityStore } from "./RemoteWorkerAuthorityStore.ts";
import { type makeCtoxRemoteWorkerAdmissionClient, type RemoteWorkerNativeReceipt } from "./ctox/CtoxRemoteWorkerAdmission.ts";

const unavailable = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
const conflict = () => new RemoteWorkerDispatchError({ reason: "request-conflict" });
const executionId = (request: RemoteWorkerRequest) => `workjet:${request.targetEnvironmentId}:${request.requestId}`;

/** Source Node authority, shared by dispatch and the worker-only listener.
 * A renderer or target cannot supply another account, permit or native target.
 * The saved intent is the sole source of those fields after preparation. */
export const makeRemoteWorkerSourceAuthority = Effect.fn("RemoteWorkerSourceAuthority.make")(function* (
  store: RemoteWorkerAuthorityStore["Service"],
  native: ReturnType<typeof makeCtoxRemoteWorkerAdmissionClient>,
  nowMs: () => number = Date.now,
) {
  const mutex = yield* Semaphore.make(1);
  const load = Effect.fn("RemoteWorkerSourceAuthority.load")(function* (request: RemoteWorkerRequest) {
    const record = yield* store.get(request.requestId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(record)) return yield* unavailable();
    if (!NodeUtil.isDeepStrictEqual(record.value.intent.request, request)) return yield* conflict();
    return record.value;
  });
  const current = Effect.fn("RemoteWorkerSourceAuthority.current")(function* (request: RemoteWorkerRequest) {
    const record = yield* load(request);
    const { scope, binding } = record.intent;
    let receipt = record.receipt;
    const save = Effect.fn("RemoteWorkerSourceAuthority.save")(function* (next: RemoteWorkerNativeReceipt) {
      yield* store.saveReceipt(request.requestId, receipt, next).pipe(Effect.mapError(unavailable));
      receipt = next;
    });
    if (receipt === null) yield* save(yield* native.execute(scope, request, binding, "issue"));
    if (receipt === null || receipt.state === "revoked") return yield* unavailable();
    if (receipt.state === "issued") {
      yield* save(yield* native.execute(scope, request, binding, "claim", receipt.permitId, executionId(request)));
    }
    if (receipt === null || receipt.state !== "claimed" || receipt.executionId !== executionId(request))
      return yield* conflict();
    // Preserve a full 120-second inference window plus native revalidation
    // overhead; delayed heartbeats must renew before requesting inference.
    if (receipt.expiresAtMs - nowMs() <= 180_000) {
      yield* save(yield* native.execute(scope, request, binding, "renew", receipt.permitId, receipt.executionId, receipt.renewalSequence + 1));
    }
    // Current native ownership/epoch and gateway grants are checked even after
    // a valid renewal and on every ordinary operation, never just at issuance.
    const checked = yield* native.execute(scope, request, binding, "revalidate", receipt.permitId, receipt.executionId ?? undefined);
    yield* save(checked);
    return { sourceConnectionId: scope.connectionId, workerRequest: request, permit: checked };
  });
  const admit = (request: RemoteWorkerRequest) => current(request).pipe(mutex.withPermits(1));
  const prepare = Effect.fn("RemoteWorkerSourceAuthority.prepare")(function* (intent: RemoteWorkerAuthorityIntent) {
    yield* store.prepare(intent).pipe(Effect.mapError(unavailable));
    return yield* admit(intent.request);
  });
  const revoke = (request: RemoteWorkerRequest) => Effect.gen(function* () {
    const record = yield* load(request);
    const receipt = record.receipt;
    if (receipt === null || receipt.state === "revoked") return;
    const next = yield* native.execute(record.intent.scope, request, record.intent.binding,
      "revoke", receipt.permitId, receipt.executionId ?? undefined);
    yield* store.saveReceipt(request.requestId, receipt, next).pipe(Effect.mapError(unavailable));
  }).pipe(mutex.withPermits(1));
  return { prepare, admit, revoke };
});
