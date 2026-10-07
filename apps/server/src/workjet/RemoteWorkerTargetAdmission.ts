// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerDispatchError } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RemoteWorkerAdmission } from "./RemoteWorkerAdmission.ts";
import { readWorkerSourceHarness } from "./WorkerSourceHarness.ts";
import { remoteWorkerRequestDigest } from "./ctox/CtoxRemoteWorkerAdmission.ts";

/** Shared by Receiver and Engine. No authority survives only in a renderer,
 * an SSH connection flag or a cached permit. Every start returns to source. */
export const layer = Layer.succeed(RemoteWorkerAdmission, RemoteWorkerAdmission.of({
  admit: (request) => Effect.gen(function* () {
    const harness = readWorkerSourceHarness(request.requestId);
    const digest = yield* remoteWorkerRequestDigest(request);
    if (!harness || harness.identity.requestId !== request.requestId ||
      harness.identity.sourceEnvironmentId !== request.parent.environmentId ||
      harness.identity.targetEnvironmentId !== request.targetEnvironmentId ||
      harness.identity.requestDigest !== digest ||
      harness.model !== request.modelSelection.model)
      return yield* new RemoteWorkerDispatchError({ reason: "computer-unavailable" });
    yield* Effect.tryPromise({
      try: harness.admit,
      catch: () => new RemoteWorkerDispatchError({ reason: "source-unavailable" }),
    });
  }),
}));
