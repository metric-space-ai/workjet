import {
  ComputerControlInput,
  ComputerControlResult,
  ComputerSshKeyInfo,
  CtoxWorkjetComputerControlResult,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopComputers } from "../../computers/DesktopComputers.ts";
import * as Channels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
export const controlComputers = DesktopIpc.makeIpcMethod({
  channel: Channels.COMPUTERS_CONTROL_CHANNEL,
  payload: ComputerControlInput,
  result: ComputerControlResult,
  handler: (input) => Effect.flatMap(DesktopComputers, (computers) => computers.control(input)),
});
export const listComputerSshKeys = DesktopIpc.makeIpcMethod({
  channel: Channels.COMPUTERS_SSH_KEYS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(ComputerSshKeyInfo),
  handler: () => Effect.flatMap(DesktopComputers, (computers) => computers.sshKeys),
});
export const assignDetectedComputer = DesktopIpc.makeIpcMethod({
  channel: Channels.COMPUTERS_ASSIGN_CHANNEL,
  payload: Schema.Struct({ id: Schema.String, instanceId: Schema.String }),
  result: CtoxWorkjetComputerControlResult,
  handler: ({ id, instanceId }) =>
    Effect.flatMap(DesktopComputers, (computers) => computers.assign(id, instanceId)),
});
export const methods = [controlComputers, listComputerSshKeys, assignDetectedComputer] as const;
