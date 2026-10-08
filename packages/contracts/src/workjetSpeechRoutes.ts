// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

/**
 * Session kinds that own their own speech routing. `regeltermin` is the
 * recurring Jour fixe; `spontan` is an ad-hoc speech session.
 */
export const WorkjetSpeechSessionKind = Schema.Literals(["regeltermin", "spontan"]);
export type WorkjetSpeechSessionKind = typeof WorkjetSpeechSessionKind.Type;

/**
 * Computer chosen to run speech-to-text or text-to-speech for one session kind.
 * `null` means the server's standard resolution applies. A selected computer
 * that cannot serve the request fails that request; it never falls back to
 * another computer silently.
 */
export const WorkjetSpeechRoute = Schema.Struct({
  sessionKind: WorkjetSpeechSessionKind,
  sttEnvironmentId: Schema.NullOr(EnvironmentId),
  ttsEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type WorkjetSpeechRoute = typeof WorkjetSpeechRoute.Type;

export const WorkjetSpeechRouteListResult = Schema.Struct({
  routes: Schema.Array(WorkjetSpeechRoute).check(Schema.isMaxLength(2)),
});
export type WorkjetSpeechRouteListResult = typeof WorkjetSpeechRouteListResult.Type;

export const WorkjetSpeechRouteSetInput = WorkjetSpeechRoute;
export type WorkjetSpeechRouteSetInput = typeof WorkjetSpeechRouteSetInput.Type;

/**
 * Speech capability the server has confirmed for one computer. Until the
 * server reports it, the picker must show the state as unknown rather than
 * available.
 */
export const WorkjetSpeechCapability = Schema.Literals(["unknown", "available", "unavailable"]);
export type WorkjetSpeechCapability = typeof WorkjetSpeechCapability.Type;
