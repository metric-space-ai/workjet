// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * In-app window for "Hinzufügen" (Cursor/Claude-style connectors).
 *
 * Same pattern as "LLM einbinden": the CTOX instance owns the OAuth flow
 * (client registration, state, PKCE verifier, token exchange and tokens) and
 * hands out an authorize URL whose redirect is a loopback address
 * (`http://127.0.0.1:<port>/toolhub/oauth/callback`, RFC 8252). This window
 * shows the provider's consent page and captures that redirect before it is
 * loaded. The captured callback URL (state + code) is returned to the caller,
 * which submits it to the instance as the sync command
 * `ctox.toolhub.oauth.complete`. Nothing is served over HTTP and no token
 * passes through the app; the code is useless without the instance's verifier.
 */
// @effect-diagnostics globalTimers:off - plain Electron window helper awaited via Effect.promise.
import { BrowserWindow } from "electron";

const CALLBACK_PATH = "/toolhub/oauth/callback";

export type ToolhubAuthorizeOutcome =
  | { readonly _tag: "captured"; readonly callbackUrl: string }
  | { readonly _tag: "cancelled" | "failed" };

export function isToolhubLoopbackCallback(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.pathname === CALLBACK_PATH &&
      url.searchParams.has("state") &&
      (url.searchParams.has("code") || url.searchParams.has("error"))
    );
  } catch {
    return false;
  }
}

export function openToolhubAuthorizeWindow(url: string): Promise<ToolhubAuthorizeOutcome> {
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
    const finish = (outcome: ToolhubAuthorizeOutcome) => {
      if (done) return;
      done = true;
      resolve(outcome);
      if (!win.isDestroyed()) win.close();
    };
    const capture = (event: { preventDefault: () => void }, target: string) => {
      if (!isToolhubLoopbackCallback(target)) return;
      event.preventDefault();
      finish({ _tag: "captured", callbackUrl: target });
    };
    win.webContents.on("will-redirect", (event, target) => capture(event, target));
    win.webContents.on("will-navigate", (event, target) => capture(event, target));
    win.webContents.setWindowOpenHandler(({ url: popup }) => {
      if (isToolhubLoopbackCallback(popup)) finish({ _tag: "captured", callbackUrl: popup });
      else if (popup.startsWith("https://")) void win.loadURL(popup);
      return { action: "deny" };
    });
    win.on("closed", () => finish({ _tag: "cancelled" }));
    void win.loadURL(url).catch(() => undefined);
  });
}
