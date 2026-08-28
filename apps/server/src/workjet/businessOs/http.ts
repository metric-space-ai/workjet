// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  WorkjetBusinessOsComputerMembershipHttpApi,
  WorkjetBusinessOsComputerMembershipAuthorityUnavailableError,
  WorkjetBusinessOsComputerMembershipInternalError,
  WorkjetBusinessOsComputerMembershipPolicyError,
  WorkjetBusinessOsComputerOwnershipError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../auth/http.ts";
import {
  WorkjetBusinessOsComputerOwnershipStore,
  type WorkjetBusinessOsComputerOwnershipStoreError,
} from "./WorkjetBusinessOsComputerOwnershipStore.ts";

export const WORKJET_BUSINESS_OS_COMPUTER_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

const appendMembershipResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, WORKJET_BUSINESS_OS_COMPUTER_RESPONSE_HEADERS),
  ),
);

const isOwnershipError = Schema.is(WorkjetBusinessOsComputerOwnershipError);

function mapMembershipError(
  error: WorkjetBusinessOsComputerOwnershipStoreError,
): Effect.Effect<
  never,
  | WorkjetBusinessOsComputerMembershipAuthorityUnavailableError
  | WorkjetBusinessOsComputerMembershipInternalError
  | WorkjetBusinessOsComputerMembershipPolicyError
> {
  if (!isOwnershipError(error)) {
    return Effect.fail(
      new WorkjetBusinessOsComputerMembershipInternalError({
        code: "computer_membership_failed",
      }),
    );
  }
  if (error.reason === "authority-unavailable") {
    return Effect.fail(
      new WorkjetBusinessOsComputerMembershipAuthorityUnavailableError({
        code: "computer_membership_authority_unavailable",
      }),
    );
  }
  return Effect.fail(
    new WorkjetBusinessOsComputerMembershipPolicyError({
      code: "computer_membership_rejected",
      reason: error.reason,
    }),
  );
}

export const businessOsComputerMembershipHttpApiLayer = HttpApiBuilder.group(
  WorkjetBusinessOsComputerMembershipHttpApi,
  "businessOsComputers",
  Effect.fnUntraced(function* (handlers) {
    const store = yield* WorkjetBusinessOsComputerOwnershipStore;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.businessOsComputers.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          yield* appendMembershipResponseHeaders;
          const [assigned, available] = yield* Effect.all(
            [
              store.listByInstance(args.payload.businessOsInstanceId),
              store.listAvailable(args.payload.businessOsInstanceId),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.catch(mapMembershipError));
          return {
            businessOsInstanceId: args.payload.businessOsInstanceId,
            assigned,
            available,
          };
        }),
      )
      .handle(
        "assign",
        Effect.fn("environment.businessOsComputers.assign")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendMembershipResponseHeaders;
          return yield* store.assign(args.payload).pipe(Effect.catch(mapMembershipError));
        }),
      )
      .handle(
        "unassign",
        Effect.fn("environment.businessOsComputers.unassign")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* appendMembershipResponseHeaders;
          return yield* store.unassign(args.payload).pipe(Effect.catch(mapMembershipError));
        }),
      );
  }),
);
