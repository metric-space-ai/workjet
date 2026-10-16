// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Google calendar sign-in on the selected instance (ctox #875,
 * `ctox.workjet.calendar.connect.v1`). The instance owns client, state, PKCE
 * verifier and tokens; Workjet only opens `authorizeUrl` and hands the captured
 * `callbackUrl` back. Native failure codes arrive as a correlated receipt with
 * `error`, never as free text.
 */
import * as Schema from "effect/Schema";
import { CommandId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WORKJET_CALENDAR_CONNECT_START = "project.calendar.account.connect.start";
export const WORKJET_CALENDAR_CONNECT_COMPLETE = "project.calendar.account.connect.complete";
/**
 * Capability probe: the native start answers `provider_unsupported` for any
 * provider but "google" before it touches attempts, secrets or rate limits.
 */
export const WORKJET_CALENDAR_CONNECT_PROBE_PROVIDER = "capability-probe";

export const WorkjetCalendarConnectErrorCode = Schema.Literals([
  "provider_unsupported",
  "oauth_client_missing",
  "redirect_unavailable",
  "permission_denied",
  "rate_limited",
  "attempt_expired",
  "state_mismatch",
  "consent_denied",
  "scope_missing",
  "token_exchange_failed",
  "account_exists",
]);
export type WorkjetCalendarConnectErrorCode = typeof WorkjetCalendarConnectErrorCode.Type;

const text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));
const AttemptId = text(128);
const Url = text(8192);

export const WorkjetCalendarConnectRequests = [
  Schema.Struct({
    action: Schema.Literal(WORKJET_CALENDAR_CONNECT_START),
    commandId: CommandId,
    provider: Schema.Literals(["google", WORKJET_CALENDAR_CONNECT_PROBE_PROVIDER]),
  }),
  Schema.Struct({
    action: Schema.Literal(WORKJET_CALENDAR_CONNECT_COMPLETE),
    commandId: CommandId,
    attemptId: AttemptId,
    callbackUrl: Url,
  }),
] as const;

export const WorkjetCalendarConnectedAccount = Schema.Struct({
  id: text(256),
  label: text(256),
  provider: Schema.Literal("google"),
  calendar_id: text(128),
  supported: Schema.Literal(true),
});
export type WorkjetCalendarConnectedAccount = typeof WorkjetCalendarConnectedAccount.Type;

export const WorkjetCalendarConnectResponses = [
  Schema.Struct({
    action: Schema.Literal(WORKJET_CALENDAR_CONNECT_START),
    commandId: CommandId,
    attemptId: AttemptId,
    authorizeUrl: Url,
    redirectUri: Url,
    scopes: Schema.Array(text(256)).check(Schema.isMaxLength(32)),
    expiresAtMs: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal(WORKJET_CALENDAR_CONNECT_COMPLETE),
    commandId: CommandId,
    account: WorkjetCalendarConnectedAccount,
  }),
  Schema.Struct({
    action: Schema.Literals([WORKJET_CALENDAR_CONNECT_START, WORKJET_CALENDAR_CONNECT_COMPLETE]),
    commandId: CommandId,
    error: WorkjetCalendarConnectErrorCode,
  }),
] as const;

export type WorkjetCalendarConnectRequest = (typeof WorkjetCalendarConnectRequests)[number]["Type"];
export type WorkjetCalendarConnectResponse =
  (typeof WorkjetCalendarConnectResponses)[number]["Type"];
