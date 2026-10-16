// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * In-app login window of the native Google calendar sign-in (ctox #875).
 *
 * The CTOX instance owns the OAuth flow (state, verifier, token exchange and
 * tokens) and hands out an authorize URL plus its redirect URI. This window
 * only shows `https://` pages of the fixed Google login origins
 * (`CALENDAR_AUTHORIZE_ORIGINS`) and captures the redirect to the
 * instance-issued redirect URI before it is loaded. Top-level navigations,
 * redirects and popups to any other origin are blocked.
 */
// @effect-diagnostics globalTimers:off - plain Electron window helper awaited via Effect.promise.
import { BrowserWindow } from "electron";

export type CalendarAuthorizeOutcome =
  | { readonly _tag: "captured"; readonly callbackUrl: string }
  | { readonly _tag: "cancelled" | "failed" };

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Pure: may the login window show `raw` as a top-level page? */
export function isAllowedAuthorizePage(raw: string, origins: ReadonlyArray<string>): boolean {
  const url = parse(raw);
  if (url === null || url.protocol !== "https:") return false;
  const allowed = new Set<string>();
  for (const origin of origins) {
    const parsed = parse(origin);
    if (parsed !== null && parsed.protocol === "https:") allowed.add(parsed.origin);
  }
  return allowed.has(url.origin);
}

/**
 * Pure: is `raw` the redirect to the instance-issued `redirectUri` of a native
 * calendar sign-in? Same scheme, host, port and path; https, or http only on
 * loopback (the rule CTOX applies to its configured redirect).
 */
export function isCalendarRedirectCallback(raw: string, redirectUri: string): boolean {
  const url = parse(raw);
  const redirect = parse(redirectUri);
  if (url === null || redirect === null || !isAcceptedCalendarRedirect(redirect)) return false;
  return (
    url.protocol === redirect.protocol &&
    url.hostname === redirect.hostname &&
    url.port === redirect.port &&
    url.pathname === redirect.pathname &&
    url.username === "" &&
    url.password === "" &&
    url.searchParams.has("state") &&
    (url.searchParams.has("code") || url.searchParams.has("error"))
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isAcceptedCalendarRedirect(redirect: URL): boolean {
  if (redirect.username !== "" || redirect.password !== "") return false;
  if (redirect.protocol === "https:") return redirect.hostname !== "";
  return redirect.protocol === "http:" && LOOPBACK_HOSTS.has(redirect.hostname);
}

/**
 * Native calendar sign-in: shows only the provider's fixed login origins (never
 * the instance) and captures the redirect to `redirectUri` before it loads, so
 * only the callback URL with its one-time code reaches the renderer.
 */
export function openCalendarAuthorizeWindow(
  url: string,
  binding: { readonly providerOrigins: ReadonlyArray<string>; readonly redirectUri: string },
): Promise<CalendarAuthorizeOutcome> {
  const redirect = parse(binding.redirectUri);
  if (redirect === null || !isAcceptedCalendarRedirect(redirect))
    return Promise.resolve({ _tag: "failed" });
  return openAuthorizeWindow(url, {
    title: "Kalender verbinden",
    isAllowedPage: (target) => isAllowedAuthorizePage(target, binding.providerOrigins),
    isCallback: (target) => isCalendarRedirectCallback(target, binding.redirectUri),
  });
}

function openAuthorizeWindow(
  url: string,
  policy: {
    readonly title: string;
    readonly isAllowedPage: (target: string) => boolean;
    readonly isCallback: (target: string) => boolean;
  },
): Promise<CalendarAuthorizeOutcome> {
  if (!policy.isAllowedPage(url)) {
    return Promise.resolve({ _tag: "failed" });
  }
  return new Promise((resolve) => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const win = new BrowserWindow({
      width: 560,
      height: 760,
      ...(parent ? { parent, modal: true } : {}),
      title: policy.title,
      autoHideMenuBar: true,
      webPreferences: {
        // Historical partition name, kept so existing Google sign-in sessions survive.
        partition: "persist:workjet-toolhub-auth",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let done = false;
    const finish = (outcome: CalendarAuthorizeOutcome) => {
      if (done) return;
      done = true;
      resolve(outcome);
      if (!win.isDestroyed()) win.close();
    };
    const guard = (event: { preventDefault: () => void }, target: string) => {
      if (policy.isCallback(target)) {
        event.preventDefault();
        finish({ _tag: "captured", callbackUrl: target });
        return;
      }
      if (!policy.isAllowedPage(target)) event.preventDefault();
    };
    win.webContents.on("will-redirect", (event, target) => guard(event, target));
    win.webContents.on("will-navigate", (event, target) => guard(event, target));
    win.webContents.setWindowOpenHandler(({ url: popup }) => {
      if (policy.isCallback(popup)) {
        finish({ _tag: "captured", callbackUrl: popup });
      } else if (policy.isAllowedPage(popup)) {
        void win.loadURL(popup).catch(() => undefined);
      }
      return { action: "deny" };
    });
    win.on("closed", () => finish({ _tag: "cancelled" }));
    void win.loadURL(url).catch(() => undefined);
  });
}
