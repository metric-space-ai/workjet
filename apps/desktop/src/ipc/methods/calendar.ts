// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { CALENDAR_AUTHORIZE_ORIGINS } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import { openCalendarAuthorizeWindow } from "../../calendar/CalendarAuthorize.ts";

const CalendarAuthorizeInput = Schema.Struct({
  instanceId: Schema.String,
  authorizeUrl: Schema.String,
  redirectUri: Schema.String,
});
const CalendarAuthorizeResult = Schema.Struct({
  _tag: Schema.Literals(["captured", "cancelled", "failed"]),
  callbackUrl: Schema.optional(Schema.String),
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
  result: CalendarAuthorizeResult,
  handler: Effect.fn("desktop.ipc.calendar.authorize")(function* (input) {
    const manager = yield* CtoxGuestManager.CtoxGuestManager;
    const instanceOrigin = yield* manager.guestInstanceOrigin(input.instanceId);
    if (instanceOrigin === undefined) return { _tag: "failed" as const };
    return yield* Effect.promise(() =>
      openCalendarAuthorizeWindow(input.authorizeUrl, {
        providerOrigins: CALENDAR_AUTHORIZE_ORIGINS,
        redirectUri: input.redirectUri,
      }),
    );
  }),
});
