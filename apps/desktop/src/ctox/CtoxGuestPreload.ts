// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { contextBridge, ipcRenderer } from "electron";

const REFRESH_MANAGED_LAUNCH_CHANNEL = "instance:refresh-managed-launch";

contextBridge.exposeInMainWorld(
  "ctoxBusinessOsDesktop",
  Object.freeze({
    refreshManagedLaunch: () => ipcRenderer.send(REFRESH_MANAGED_LAUNCH_CHANNEL),
  }),
);
