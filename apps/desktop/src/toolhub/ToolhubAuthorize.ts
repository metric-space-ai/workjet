// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * In-app window for "Hinzufügen" (Cursor/Claude-style connectors).
 *
 * The CTOX instance owns the whole OAuth flow: DCR registration with its own
 * public callback, state, PKCE verifier and tokens. This window only shows the
 * provider's consent page and closes once the instance callback page
 * (`/toolhub/oauth/callback`) has rendered its result.
 */
// @effect-diagnostics globalTimers:off - plain Electron window helper awaited via Effect.promise.
import { BrowserWindow } from "electron";

const CALLBACK_PATH = "/toolhub/oauth/callback";

export function openToolhubAuthorizeWindow(
  url: string,
): Promise<{ readonly _tag: "completed" | "cancelled" | "failed" }> {
  return new Promise((resolve) => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const win = new BrowserWindow({
      width: 560,
      height: 760,
      ...(parent ? { parent, modal: true } : {}),
      title: "Schnittstelle verbinden",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:workjet-toolhub-auth",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let done = false;
    const finish = (tag: "completed" | "cancelled" | "failed") => {
      if (done) return;
      done = true;
      resolve({ _tag: tag });
      if (!win.isDestroyed()) setTimeout(() => win.isDestroyed() || win.close(), 900);
    };
    win.webContents.on("did-finish-load", () => {
      let path = "";
      try {
        path = new URL(win.webContents.getURL()).pathname;
      } catch {
        return;
      }
      if (path !== CALLBACK_PATH) return;
      void win.webContents
        .executeJavaScript("document.body?.dataset.toolhubResult ?? ''", true)
        .then((result: unknown) => finish(result === "connected" ? "completed" : "failed"))
        .catch(() => finish("failed"));
    });
    win.webContents.setWindowOpenHandler(({ url: popup }) => {
      if (popup.startsWith("https://")) void win.loadURL(popup);
      return { action: "deny" };
    });
    win.on("closed", () => finish("cancelled"));
    void win.loadURL(url).catch(() => undefined);
  });
}
