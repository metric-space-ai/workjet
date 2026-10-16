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
  isAllowedToolhubAuthorizePage,
  isCalendarRedirectCallback,
  isToolhubInstanceCallback,
  openCalendarAuthorizeWindow,
  openToolhubAuthorizeWindow,
} from "./ToolhubAuthorize.ts";

const binding = {
  instanceOrigin: "https://acme.ctox.dev",
  providerOrigins: ["https://mcp.vercel.com", "https://vercel.com"],
};

describe("toolhub login window origin binding", () => {
  it("shows only https pages of the instance or the provider's fixed origins", () => {
    expect(isAllowedToolhubAuthorizePage("https://acme.ctox.dev/toolhub/x", binding)).toBe(true);
    expect(isAllowedToolhubAuthorizePage("https://vercel.com/oauth/authorize?a=1", binding)).toBe(
      true,
    );
    expect(isAllowedToolhubAuthorizePage("https://evil.example/login", binding)).toBe(false);
    expect(isAllowedToolhubAuthorizePage("https://vercel.com.evil.example/", binding)).toBe(false);
    expect(isAllowedToolhubAuthorizePage("http://vercel.com/oauth/authorize", binding)).toBe(false);
    expect(isAllowedToolhubAuthorizePage("https://acme.ctox.dev:8443/", binding)).toBe(false);
    expect(isAllowedToolhubAuthorizePage("javascript:alert(1)", binding)).toBe(false);
  });

  it("refuses a foreign authorize URL without opening a window", async () => {
    const outcome = await openToolhubAuthorizeWindow("https://evil.example/authorize", binding);
    expect(outcome).toEqual({ _tag: "failed" });
    expect(created).toHaveLength(0);
  });

  it("refuses a provider URL when the toolkit has no fixed authorization origin", async () => {
    const outcome = await openToolhubAuthorizeWindow("https://vercel.com/oauth/authorize", {
      instanceOrigin: "https://acme.ctox.dev",
      providerOrigins: [],
    });
    expect(outcome).toEqual({ _tag: "failed" });
    expect(created).toHaveLength(0);
  });

  it("captures the callback only on the instance's host and port", () => {
    const ok = "https://acme.ctox.dev/toolhub/oauth/callback?state=s&code=c";
    expect(isToolhubInstanceCallback(ok, binding.instanceOrigin)).toBe(true);
    expect(
      isToolhubInstanceCallback(
        "https://acme.ctox.dev/toolhub/oauth/callback?state=s&error=denied",
        binding.instanceOrigin,
      ),
    ).toBe(true);
    expect(
      isToolhubInstanceCallback(
        "https://other.ctox.dev/toolhub/oauth/callback?state=s&code=c",
        binding.instanceOrigin,
      ),
    ).toBe(false);
    expect(
      isToolhubInstanceCallback(
        "https://acme.ctox.dev:4443/toolhub/oauth/callback?state=s&code=c",
        binding.instanceOrigin,
      ),
    ).toBe(false);
    expect(
      isToolhubInstanceCallback(
        "http://127.0.0.1:9000/toolhub/oauth/callback?state=s&code=c",
        binding.instanceOrigin,
      ),
    ).toBe(false);
    expect(
      isToolhubInstanceCallback(
        "http://127.0.0.1:9000/toolhub/oauth/callback?state=s&code=c",
        "http://127.0.0.1:9000",
      ),
    ).toBe(true);
    expect(
      isToolhubInstanceCallback(
        "https://acme.ctox.dev/toolhub/oauth/callback?code=c",
        binding.instanceOrigin,
      ),
    ).toBe(false);
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
