// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import { toolhubConnect } from "../../toolhub/ToolhubAuthorize.ts";

const ToolhubConnectInput = Schema.Struct({
  server: Schema.String,
  serverUrl: Schema.String,
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

const ToolhubConnectResultSchema = Schema.Struct({
  _tag: Schema.Literals(["authorized", "cancelled", "failed"]),
  server: Schema.String,
  message: Schema.optional(Schema.String),
});

/** Opens the provider's hosted consent page in an in-app window. */
export const connectToolhubServer = makeIpcMethod({
  channel: IpcChannels.TOOLHUB_CONNECT_CHANNEL,
  payload: ToolhubConnectInput,
  result: ToolhubConnectResultSchema,
  handler: Effect.fn("desktop.ipc.toolhub.connect")(function* (input) {
    if (!input.serverUrl.startsWith("https://")) {
      return { _tag: "failed" as const, server: input.server, message: "https required" };
    }
    return yield* Effect.promise(() => toolhubConnect(input));
  }),
});
