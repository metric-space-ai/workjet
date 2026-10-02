// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { DesktopSupportBundleResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopSupportBundle from "../../support/DesktopSupportBundle.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/**
 * Builds a redacted support bundle and reports where it landed.
 *
 * The renderer receives only the RESULT — path, size, and how many fields the
 * gate redacted or omitted — never the document itself. Nothing crosses the
 * bridge that the user cannot open and read on disk first, and there is no
 * companion "send" method: the bundle's only exit from the machine is the
 * user attaching the file themselves.
 */
export const createSupportBundle = makeIpcMethod({
  channel: IpcChannels.CREATE_SUPPORT_BUNDLE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSupportBundleResult,
  handler: Effect.fn("desktop.ipc.support.createSupportBundle")(function* () {
    const supportBundle = yield* DesktopSupportBundle.DesktopSupportBundle;
    return yield* supportBundle.create;
  }),
});
