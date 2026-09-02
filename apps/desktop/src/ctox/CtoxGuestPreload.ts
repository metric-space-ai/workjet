// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { contextBridge, ipcRenderer } from "electron";

const REFRESH_MANAGED_LAUNCH_CHANNEL = "instance:refresh-managed-launch";
const APPLY_HOST_THEME_CHANNEL = "instance:apply-host-theme";
const SESSION_TRANSFER_EVENT_CHANNEL = "ctox-guest:session-transfer-event";

const HOST_THEME_TOKEN_KEYS = new Set([
  "bg",
  "surface",
  "surface-2",
  "surface-3",
  "line",
  "hairline",
  "text",
  "text-strong",
  "muted",
  "accent",
  "accent-foreground",
  "accent-soft",
]);
const HOST_THEME_COLOR_PATTERN =
  /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([^;{}<>"'`\\]{1,64}\))$/;

function applyHostTheme(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const record = payload as { readonly scheme?: unknown; readonly tokens?: unknown };
  const scheme = record.scheme === "light" ? "light" : record.scheme === "dark" ? "dark" : null;
  if (scheme === null) return;
  const root = document.documentElement;
  root.dataset["desktopHost"] = "ctox";
  root.dataset["theme"] = scheme;
  if (typeof record.tokens !== "object" || record.tokens === null) return;
  for (const [key, value] of Object.entries(record.tokens as Record<string, unknown>)) {
    if (!HOST_THEME_TOKEN_KEYS.has(key)) continue;
    if (typeof value !== "string" || value.length > 72 || !HOST_THEME_COLOR_PATTERN.test(value)) {
      continue;
    }
    root.style.setProperty(`--ctox-host-${key}`, value);
  }
}

ipcRenderer.on(APPLY_HOST_THEME_CHANNEL, (_event, payload: unknown) => {
  applyHostTheme(payload);
});

contextBridge.exposeInMainWorld(
  "ctoxBusinessOsDesktop",
  Object.freeze({
    refreshManagedLaunch: () => ipcRenderer.send(REFRESH_MANAGED_LAUNCH_CHANNEL),
  }),
);

contextBridge.exposeInMainWorld(
  "workjetHostBridge",
  Object.freeze({
    postSessionTransferEvent: (event: unknown) =>
      ipcRenderer.send(SESSION_TRANSFER_EVENT_CHANNEL, event),
  }),
);
