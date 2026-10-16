import { describe, expect, it, vi } from "vite-plus/test";

const created: string[] = [];
vi.mock("electron", () => ({
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    constructor() {
      created.push("window");
    }
  },
}));

import {
  isAllowedAuthorizePage,
  isCalendarRedirectCallback,
  openCalendarAuthorizeWindow,
} from "./CalendarAuthorize.ts";

const origins = ["https://accounts.google.com"];

describe("calendar login window origin binding", () => {
  it("shows only https pages of the fixed login origins", () => {
    expect(isAllowedAuthorizePage("https://accounts.google.com/o/oauth2/v2/auth", origins)).toBe(
      true,
    );
    expect(isAllowedAuthorizePage("https://evil.example/login", origins)).toBe(false);
    expect(isAllowedAuthorizePage("https://accounts.google.com.evil.example/", origins)).toBe(
      false,
    );
    expect(isAllowedAuthorizePage("http://accounts.google.com/o/oauth2/v2/auth", origins)).toBe(
      false,
    );
    expect(isAllowedAuthorizePage("https://accounts.google.com:8443/", origins)).toBe(false);
    expect(isAllowedAuthorizePage("javascript:alert(1)", origins)).toBe(false);
    expect(isAllowedAuthorizePage("https://accounts.google.com/", [])).toBe(false);
  });
});

describe("calendar sign-in window (ctox #875)", () => {
  const redirect = "https://acme.ctox.dev/google/oauth/callback";
  const google = { providerOrigins: ["https://accounts.google.com"], redirectUri: redirect };

  it("captures only the instance-issued redirect with state and code or error", () => {
    expect(isCalendarRedirectCallback(`${redirect}?state=s&code=c`, redirect)).toBe(true);
    expect(isCalendarRedirectCallback(`${redirect}?state=s&error=access_denied`, redirect)).toBe(
      true,
    );
    expect(isCalendarRedirectCallback(`${redirect}?code=c`, redirect)).toBe(false);
    expect(isCalendarRedirectCallback(`${redirect}/x?state=s&code=c`, redirect)).toBe(false);
    expect(
      isCalendarRedirectCallback(
        "https://evil.example/google/oauth/callback?state=s&code=c",
        redirect,
      ),
    ).toBe(false);
    expect(
      isCalendarRedirectCallback(
        "http://acme.ctox.dev/google/oauth/callback?state=s&code=c",
        redirect,
      ),
    ).toBe(false);
    expect(
      isCalendarRedirectCallback(
        "http://127.0.0.1:8765/oauth?state=s&code=c",
        "http://127.0.0.1:8765/oauth",
      ),
    ).toBe(true);
    expect(
      isCalendarRedirectCallback(
        "http://intranet.example/oauth?state=s&code=c",
        "http://intranet.example/oauth",
      ),
    ).toBe(false);
  });

  it("refuses an authorize URL outside the fixed Google login origin without a window", async () => {
    for (const url of [
      "https://acme.ctox.dev/google/oauth/start",
      "https://accounts.google.com.evil.example/o/oauth2/v2/auth",
      "http://accounts.google.com/o/oauth2/v2/auth",
    ]) {
      expect(await openCalendarAuthorizeWindow(url, google)).toEqual({ _tag: "failed" });
    }
    expect(
      await openCalendarAuthorizeWindow("https://accounts.google.com/o/oauth2/v2/auth", {
        ...google,
        redirectUri: "http://intranet.example/oauth",
      }),
    ).toEqual({ _tag: "failed" });
    expect(created).toHaveLength(0);
  });
});
