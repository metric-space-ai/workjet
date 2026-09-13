import { DesktopTailscalePeersSchema } from "@workjet/contracts";
import { readTailscalePeers } from "@workjet/tailscale";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const discoverTailscalePeers = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_TAILSCALE_PEERS_CHANNEL,
  payload: Schema.Void,
  result: DesktopTailscalePeersSchema,
  handler: () =>
    readTailscalePeers.pipe(
      // Do not forward CLI output or diagnostic causes into the renderer.
      Effect.orElseSucceed(() => ({ status: "unavailable" as const, peers: [] })),
    ),
});
