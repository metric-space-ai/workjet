import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopTray from "../../tray/DesktopTray.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const LoginItemStateSchema = Schema.Struct({
  supported: Schema.Boolean,
  openAtLogin: Schema.Boolean,
});

const TrayProjectsSchema = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    title: Schema.String,
  }),
);

export const getLoginItemState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_LOGIN_ITEM_STATE_CHANNEL,
  payload: Schema.Void,
  result: LoginItemStateSchema,
  handler: Effect.fn("desktop.ipc.tray.getLoginItemState")(function* () {
    const tray = yield* DesktopTray.DesktopTray;
    return yield* tray.loginItemState;
  }),
});

export const setOpenAtLogin = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_OPEN_AT_LOGIN_CHANNEL,
  payload: Schema.Boolean,
  result: LoginItemStateSchema,
  handler: Effect.fn("desktop.ipc.tray.setOpenAtLogin")(function* (enabled) {
    const tray = yield* DesktopTray.DesktopTray;
    return yield* tray.setOpenAtLogin(enabled);
  }),
});

export const setTrayProjects = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_TRAY_PROJECTS_CHANNEL,
  payload: TrayProjectsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.tray.setProjects")(function* (projects) {
    const tray = yield* DesktopTray.DesktopTray;
    yield* tray.setProjects(projects);
  }),
});

export const methods = [getLoginItemState, setOpenAtLogin, setTrayProjects] as const;
