import {
  WorkjetProvisioningGetInput,
  WorkjetProvisioningGetResult,
  WorkjetProvisioningPreflightInput,
  WorkjetProvisioningPreflightResult,
  WorkjetProvisioningStartInput,
  WorkjetProvisioningStartResult,
  WorkjetSshHostKeyInspectInput,
  WorkjetSshHostKeyInspectResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopComputerProvisioner from "../../provisioning/DesktopComputerProvisioner.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const inspectHostKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROVISIONING_INSPECT_HOST_KEY_CHANNEL,
  payload: WorkjetSshHostKeyInspectInput,
  result: WorkjetSshHostKeyInspectResult,
  handler: ({ target }) =>
    Effect.flatMap(DesktopComputerProvisioner.DesktopComputerProvisioner, (provisioner) =>
      provisioner.inspectHostKey(target),
    ),
});

export const preflight = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROVISIONING_PREFLIGHT_CHANNEL,
  payload: WorkjetProvisioningPreflightInput,
  result: WorkjetProvisioningPreflightResult,
  handler: (input) =>
    Effect.flatMap(DesktopComputerProvisioner.DesktopComputerProvisioner, (provisioner) =>
      provisioner.preflight(input),
    ),
});

export const start = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROVISIONING_START_CHANNEL,
  payload: WorkjetProvisioningStartInput,
  result: WorkjetProvisioningStartResult,
  handler: (input) =>
    Effect.flatMap(DesktopComputerProvisioner.DesktopComputerProvisioner, (provisioner) =>
      provisioner.start(input),
    ),
});

export const get = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROVISIONING_GET_CHANNEL,
  payload: WorkjetProvisioningGetInput,
  result: WorkjetProvisioningGetResult,
  handler: ({ operationId }) =>
    Effect.flatMap(DesktopComputerProvisioner.DesktopComputerProvisioner, (provisioner) =>
      provisioner.get(operationId),
    ),
});

export const methods = [inspectHostKey, preflight, start, get] as const;
