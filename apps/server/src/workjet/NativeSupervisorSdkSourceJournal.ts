// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Private original-controller IPC correlation only.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  NativeSupervisorSdkJournal,
  type NativeSupervisorSdkObservation,
} from "./NativeSupervisorSdkJournal.ts";
import type { NativeSupervisorSourceTransport } from "./NativeSupervisorSourceTransport.ts";

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const Controller = Schema.Struct({ offerId: Uuid, controllerId: Uuid });
const Observed = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("sdk_observed"),
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 511 })),
  execution_ready: Schema.Literal(false),
});
const decodeObserved = Schema.decodeUnknownPromise(Observed, { onExcessProperty: "error" });

function sourceObservation(observation: NativeSupervisorSdkObservation) {
  const common = {
    version: observation.version,
    sequence: observation.sequence,
    kind: observation.kind,
  };
  switch (observation.kind) {
    case "child-spawned":
      return { ...common, pid: observation.pid };
    case "child-closed":
      return {
        ...common,
        pid: observation.pid,
        ...(observation.exitCode !== null ? { exit_code: observation.exitCode } : {}),
        ...(observation.signal !== null ? { signal: observation.signal } : {}),
      };
    case "sdk-init":
      return { ...common, session_id: observation.sessionId, init_id: observation.initId };
    case "turn-submitted":
      return { ...common, turn_id: observation.turnId };
    case "parent-assistant":
      return {
        ...common,
        session_id: observation.sessionId,
        turn_id: observation.turnId,
        message_id: observation.messageId,
        message_model: observation.messageModel,
        assistant_id: observation.assistantId,
      };
    case "sdk-result":
      return {
        ...common,
        session_id: observation.sessionId,
        turn_id: observation.turnId,
        result_id: observation.resultId,
        subtype: observation.subtype,
        is_error: observation.isError,
      };
    case "sdk-stream-joined":
    case "sdk-query-close-returned":
      return common;
    default:
      return observation satisfies never;
  }
}

/** Private Node service construction, never a settings/RPC or reported-effects API.
 * The supplied transport is the same retained original Source child. Native
 * validates its original peer/controller on every append; IDs are correlation.
 * An ambiguous IPC result fails this journal without replay, rebind or authority. */
export function createNativeSupervisorSdkSourceJournal(options: {
  readonly offerId: string;
  readonly controllerId: string;
  readonly transport: Pick<NativeSupervisorSourceTransport, "request">;
}): NativeSupervisorSdkJournal {
  const { offerId, controllerId } = Schema.decodeUnknownSync(Controller)({
    offerId: options.offerId,
    controllerId: options.controllerId,
  });
  const request = options.transport.request.bind(options.transport);
  return new NativeSupervisorSdkJournal(async (observation) => {
    const reply = await request(NodeCrypto.randomUUID(), {
      version: 1,
      action: "sdk_observe",
      offer_id: offerId,
      controller_id: controllerId,
      sdk_observation: sourceObservation(observation),
    });
    const observed = await decodeObserved(reply);
    if (observed.sequence !== observation.sequence)
      throw new Error("Original SDK observation acknowledgement sequence differs.");
  });
}
