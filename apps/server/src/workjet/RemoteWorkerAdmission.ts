// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerDispatchError, type RemoteWorkerRequest } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** A current source-native execution check, not a catalog or cached receipt.
 * The concrete platform adapter intersects native authority and gateway grant.
 * It must be safe to repeat under the same immutable worker execution identity. */
export class RemoteWorkerAdmission extends Context.Service<
  RemoteWorkerAdmission,
  { readonly admit: (request: RemoteWorkerRequest) => Effect.Effect<void, RemoteWorkerDispatchError> }
>()("workjet/workjet/RemoteWorkerAdmission") {}

