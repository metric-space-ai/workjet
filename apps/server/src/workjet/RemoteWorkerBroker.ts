import * as NodeUtil from "node:util";
import { ModelSelection, RemoteWorkerDispatchError, type RemoteWorkerRequest, type RemoteWorkerResponse, type ThreadId } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RemoteWorkerStore } from "./RemoteWorkerStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const make = Effect.gen(function* () {
  const store = yield* RemoteWorkerStore;
  const query = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const pending = Effect.gen(function* () {
    const catalog = (yield* settings.getSettings).workjet.computers;
    const requests = yield* store.pendingOutbound;
    const live: RemoteWorkerRequest[] = [];
    for (const request of requests) {
      const parent = Option.getOrUndefined(yield* query.getThreadDetailById(request.parent.threadId));
      const computer = catalog.filter((entry) => entry.id === request.computerId);
      if (parent && parent.deletedAt === null && parent.archivedAt == null &&
        parent.workjetConfig.role === "orchestrator" && computer.length === 1 &&
        computer[0]?.environmentId === request.targetEnvironmentId &&
        request.enabledCapabilityIds.every((id) => parent.workjetConfig.enabledCapabilityIds.includes(id))) {
        live.push(request);
      } else {
        yield* store.complete("outbound", {
          requestId: request.requestId, outcome: { status: "failed", reason: "source-unavailable" },
        });
      }
    }
    return live;
  }).pipe(Effect.mapError(() => new RemoteWorkerDispatchError({ reason: "source-unavailable" })));
  const enqueue = Effect.fn("RemoteWorkerBroker.enqueue")(function* (request: RemoteWorkerRequest) {
    yield* store.put("outbound", request).pipe(Effect.mapError(() =>
      new RemoteWorkerDispatchError({ reason: "request-conflict" })));
  });
  const read = Effect.fn("RemoteWorkerBroker.read")(function* (requestId: ThreadId) {
    return yield* store.get("outbound", requestId).pipe(Effect.mapError(() =>
      new RemoteWorkerDispatchError({ reason: "source-unavailable" })));
  });
  const respond = Effect.fn("RemoteWorkerBroker.respond")(function* (response: RemoteWorkerResponse) {
    const saved = yield* read(response.requestId);
    if (Option.isNone(saved)) return yield* new RemoteWorkerDispatchError({ reason: "invalid-request" });
    if (response.outcome.status === "dispatched") {
      const request = saved.value.request;
      const result = response.outcome.result;
      if (result.workerThreadId !== request.requestId || result.environmentId !== request.targetEnvironmentId ||
        result.computerId !== request.computerId || result.parent.environmentId !== request.parent.environmentId ||
        result.parent.threadId !== request.parent.threadId || result.branch !== `workjet/worker/${request.requestId}` ||
        result.enabledCapabilityIds.length !== request.enabledCapabilityIds.length ||
        result.enabledCapabilityIds.some((id) => !request.enabledCapabilityIds.includes(id)) ||
        !NodeUtil.isDeepStrictEqual(Schema.encodeSync(ModelSelection)(result.modelSelection), Schema.encodeSync(ModelSelection)(request.modelSelection))) {
        return yield* new RemoteWorkerDispatchError({ reason: "invalid-request" });
      }
    }
    yield* store.complete("outbound", response).pipe(Effect.mapError(() =>
      new RemoteWorkerDispatchError({ reason: "request-conflict" })));
  });
  const awaitResponse = Effect.fn("RemoteWorkerBroker.awaitResponse")(function* (requestId: ThreadId) {
    while (true) {
      const saved = yield* read(requestId);
      if (Option.isNone(saved)) return yield* new RemoteWorkerDispatchError({ reason: "invalid-request" });
      if (saved.value.response) return saved.value.response;
      yield* Effect.sleep("1 second");
    }
  });
  return {
    enqueue, read, respond, awaitResponse,
    requests: Stream.fromEffect(pending).pipe(Stream.repeat(Schedule.spaced("2 seconds"))),
  };
});
export class RemoteWorkerBroker extends Context.Service<RemoteWorkerBroker, Effect.Success<typeof make>>()(
  "workjet/workjet/RemoteWorkerBroker",
) {}
export const layer = Layer.effect(RemoteWorkerBroker, make);
