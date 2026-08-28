import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDeepLinkRouter from "../../app/DesktopDeepLinkRouter.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/**
 * One OS-delivered deep link awaiting the user's explicit confirmation. The
 * renderer receives the description only — the main process never navigates
 * on its own.
 */
export const DesktopPendingDeepLinkSchema = Schema.Struct({
  linkId: Schema.String,
  scheme: Schema.String,
  canonicalUrl: Schema.String,
  path: Schema.String,
  search: Schema.String,
  hash: Schema.String,
});

export const DesktopPendingDeepLinksSchema = Schema.Array(DesktopPendingDeepLinkSchema);

/**
 * Drains the queue. This is the only way a link leaves the main process, so a
 * link is delivered exactly once even when the "links are waiting" push races
 * the renderer's mount-time drain.
 */
export const takePendingDeepLinks = makeIpcMethod({
  channel: IpcChannels.TAKE_PENDING_DEEP_LINKS_CHANNEL,
  payload: Schema.Void,
  result: DesktopPendingDeepLinksSchema,
  handler: Effect.fn("desktop.ipc.deepLinks.takePending")(function* () {
    const router = yield* DesktopDeepLinkRouter.DesktopDeepLinkRouter;
    return yield* router.takePending;
  }),
});
