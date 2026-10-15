// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * In-app window for "Hinzufügen" (developer mode only until ctox #708 lands).
 *
 * The CTOX instance owns the OAuth flow (client registration, state, PKCE
 * verifier, token exchange and tokens) and hands out an authorize URL. This
 * window shows the provider's consent page and captures the redirect back to
 * the instance (`<instance>/toolhub/oauth/callback`) before it is loaded.
 *
 * The window is origin-bound: it only opens `https://` URLs whose origin is the
 * selected instance's origin or one of the provider's authorization origins
 * fixed in the app (`TOOLHUB_AUTHORIZE_ORIGINS`). Top-level navigations,
 * redirects and popups to any other origin are blocked. The callback is only
 * accepted on the instance's own host and port.
 */
// @effect-diagnostics globalTimers:off - plain Electron window helper awaited via Effect.promise.
import { BrowserWindow } from "electron";

const CALLBACK_PATH = "/toolhub/oauth/callback";

export type ToolhubAuthorizeOutcome =
  | { readonly _tag: "captured"; readonly callbackUrl: string }
  | { readonly _tag: "cancelled" | "failed" };

/** The origins this login window may show. */
export interface ToolhubAuthorizeBinding {
  /** Origin of the selected instance, e.g. `https://acme.ctox.dev`. */
  readonly instanceOrigin: string;
  /** Authorization origins of the provider, fixed in the app catalog. */
  readonly providerOrigins: ReadonlyArray<string>;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Pure: is `raw` the instance's OAuth callback (same host and port as the instance)? */
export function isToolhubInstanceCallback(raw: string, instanceOrigin: string): boolean {
  const url = parse(raw);
  const instance = parse(instanceOrigin);
  if (url === null || instance === null) return false;
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.hostname === instance.hostname &&
    url.port === instance.port &&
    url.pathname === CALLBACK_PATH &&
    url.searchParams.has("state") &&
    (url.searchParams.has("code") || url.searchParams.has("error"))
  );
}

/** Pure: may the login window show `raw` as a top-level page? */
export function isAllowedToolhubAuthorizePage(
  raw: string,
  binding: ToolhubAuthorizeBinding,
): boolean {
  const url = parse(raw);
  if (url === null || url.protocol !== "https:") return false;
  const allowed = new Set<string>();
  for (const origin of [binding.instanceOrigin, ...binding.providerOrigins]) {
    const parsed = parse(origin);
    if (parsed !== null && parsed.protocol === "https:") allowed.add(parsed.origin);
  }
  return allowed.has(url.origin);
}

export function openToolhubAuthorizeWindow(
  url: string,
  binding: ToolhubAuthorizeBinding,
): Promise<ToolhubAuthorizeOutcome> {
  if (!isAllowedToolhubAuthorizePage(url, binding)) {
    return Promise.resolve({ _tag: "failed" });
  }
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
    const guard = (event: { preventDefault: () => void }, target: string) => {
      if (isToolhubInstanceCallback(target, binding.instanceOrigin)) {
        event.preventDefault();
        finish({ _tag: "captured", callbackUrl: target });
        return;
      }
      if (!isAllowedToolhubAuthorizePage(target, binding)) event.preventDefault();
    };
    win.webContents.on("will-redirect", (event, target) => guard(event, target));
    win.webContents.on("will-navigate", (event, target) => guard(event, target));
    win.webContents.setWindowOpenHandler(({ url: popup }) => {
      if (isToolhubInstanceCallback(popup, binding.instanceOrigin)) {
        finish({ _tag: "captured", callbackUrl: popup });
      } else if (isAllowedToolhubAuthorizePage(popup, binding)) {
        void win.loadURL(popup).catch(() => undefined);
      }
      return { action: "deny" };
    });
    win.on("closed", () => finish({ _tag: "cancelled" }));
    void win.loadURL(url).catch(() => undefined);
  });
}
