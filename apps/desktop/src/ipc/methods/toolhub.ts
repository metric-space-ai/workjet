// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import { openToolhubAuthorizeWindow } from "../../toolhub/ToolhubAuthorize.ts";

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
    const manager = yield* CtoxGuestManager.CtoxGuestManager;
    return yield* manager.requestToolhub(input.instanceId, input.route, input.body);
  }),
});

const ToolhubAuthorizeInput = Schema.Struct({ authorizeUrl: Schema.String });
const ToolhubAuthorizeResult = Schema.Struct({
  _tag: Schema.Literals(["captured", "cancelled", "failed"]),
  callbackUrl: Schema.optional(Schema.String),
});

/**
 * Opens the authorize URL the INSTANCE handed out in an in-app window and
 * captures the provider's loopback redirect (state + code), like "LLM
 * einbinden". The caller submits it to the instance over ctox sync
 * (`oauth/complete` -> `ctox.toolhub.oauth.complete`); the instance exchanges
 * the code with its own PKCE verifier. No token passes through the app.
 */
export const authorizeToolhub = makeIpcMethod({
  channel: IpcChannels.TOOLHUB_AUTHORIZE_CHANNEL,
  payload: ToolhubAuthorizeInput,
  result: ToolhubAuthorizeResult,
  handler: Effect.fn("desktop.ipc.toolhub.authorize")(function* (input) {
    if (!input.authorizeUrl.startsWith("https://")) return { _tag: "failed" as const };
    return yield* Effect.promise(() => openToolhubAuthorizeWindow(input.authorizeUrl));
  }),
});
