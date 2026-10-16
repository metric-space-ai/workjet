// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Schnittstellen (CTOX Toolhub) — developer mode only.
 *
 * The full store needs ctox #708 and a main-process → instance handoff of the
 * OAuth code. Until then both methods refuse to run unless the user switched
 * on developer mode; the renderer does not call them without it either.
 */
import { toolhubAuthorizeOrigins } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import {
  openCalendarAuthorizeWindow,
  openToolhubAuthorizeWindow,
} from "../../toolhub/ToolhubAuthorize.ts";

const developerModeOn = Effect.gen(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const settings = yield* clientSettings.get;
  return Option.isSome(settings) && settings.value.developerMode === true;
});

const ToolhubRequestInput = Schema.Struct({
  instanceId: Schema.String,
  route: Schema.String,
  body: Schema.optional(Schema.Unknown),
});
const ToolhubRequestResult = Schema.Struct({ status: Schema.Number, body: Schema.Unknown });

/** Toolhub control plane on the selected instance (via the authenticated guest). */
export const requestToolhub = makeIpcMethod({
  channel: IpcChannels.TOOLHUB_REQUEST_CHANNEL,
  payload: ToolhubRequestInput,
  result: ToolhubRequestResult,
  handler: Effect.fn("desktop.ipc.toolhub.request")(function* (input) {
    if (!(yield* developerModeOn)) {
      return { status: 403, body: { ok: false, message: "developer_mode_required" } };
    }
    const manager = yield* CtoxGuestManager.CtoxGuestManager;
    return yield* manager.requestToolhub(input.instanceId, input.route, input.body);
  }),
});

const ToolhubAuthorizeInput = Schema.Struct({
  instanceId: Schema.String,
  toolkit: Schema.String,
  authorizeUrl: Schema.String,
});
const ToolhubAuthorizeResult = Schema.Struct({
  _tag: Schema.Literals(["captured", "cancelled", "failed"]),
  callbackUrl: Schema.optional(Schema.String),
});

/**
 * Opens the authorize URL the INSTANCE handed out in an origin-bound in-app
 * window: only the instance's own origin and the provider's authorization
 * origins fixed in the app catalog can be shown, and the redirect is only
 * captured on the instance's host and port.
 */
export const authorizeToolhub = makeIpcMethod({
  channel: IpcChannels.TOOLHUB_AUTHORIZE_CHANNEL,
  payload: ToolhubAuthorizeInput,
  result: ToolhubAuthorizeResult,
  handler: Effect.fn("desktop.ipc.toolhub.authorize")(function* (input) {
    if (!(yield* developerModeOn)) return { _tag: "failed" as const };
    const manager = yield* CtoxGuestManager.CtoxGuestManager;
    const instanceOrigin = yield* manager.toolhubInstanceOrigin(input.instanceId);
    if (instanceOrigin === undefined) return { _tag: "failed" as const };
    return yield* Effect.promise(() =>
      openToolhubAuthorizeWindow(input.authorizeUrl, {
        instanceOrigin,
        providerOrigins: toolhubAuthorizeOrigins(input.toolkit),
      }),
    );
  }),
});

const CalendarAuthorizeInput = Schema.Struct({
  instanceId: Schema.String,
  authorizeUrl: Schema.String,
  redirectUri: Schema.String,
});

/**
 * Native Google calendar sign-in (ctox #875), not developer-mode gated: the
 * instance issued `authorizeUrl` and `redirectUri`; the window only shows the
 * fixed Google login origin and captures the redirect before it loads. The
 * selected instance must still be pooled, so no foreign renderer input opens it.
 */
export const authorizeCalendar = makeIpcMethod({
  channel: IpcChannels.CALENDAR_AUTHORIZE_CHANNEL,
  payload: CalendarAuthorizeInput,
  result: ToolhubAuthorizeResult,
  handler: Effect.fn("desktop.ipc.calendar.authorize")(function* (input) {
    const manager = yield* CtoxGuestManager.CtoxGuestManager;
    const instanceOrigin = yield* manager.toolhubInstanceOrigin(input.instanceId);
    if (instanceOrigin === undefined) return { _tag: "failed" as const };
    return yield* Effect.promise(() =>
      openCalendarAuthorizeWindow(input.authorizeUrl, {
        providerOrigins: toolhubAuthorizeOrigins("google-calendar"),
        redirectUri: input.redirectUri,
      }),
    );
  }),
});
