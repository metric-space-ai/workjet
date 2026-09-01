import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import * as ElectronProtocol from "../electron/desktopSchemes.ts";
import {
  isDesktopDeepLinkScheme,
  parseDesktopDeepLink,
  resolveDesktopDeepLinkRedirect,
} from "./DesktopDeepLink.ts";

describe("desktop protocol schemes", () => {
  it("claims Workjet schemes alongside inbound legacy aliases", () => {
    assert.deepEqual(ElectronProtocol.DESKTOP_DEEP_LINK_SCHEMES, [
      "workjet",
      "workjet-dev",
      "workjet-preview",
      "ctox-desktop",
      "ctox-desktop-dev",
      "t3code",
      "t3code-dev",
    ]);
  });

  it("prefers the Workjet scheme per build variant and keeps inbound aliases", () => {
    assert.deepEqual(ElectronProtocol.getDesktopDeepLinkSchemes(false), [
      "workjet",
      "ctox-desktop",
      "t3code",
    ]);
    assert.deepEqual(ElectronProtocol.getDesktopDeepLinkSchemes(true), [
      "workjet-dev",
      "ctox-desktop-dev",
      "t3code-dev",
    ]);
  });

  it("never claims the CTOX daemon's own ctox: namespace", () => {
    assert.isFalse(ElectronProtocol.DESKTOP_DEEP_LINK_SCHEMES.includes("ctox"));
    assert.isFalse(isDesktopDeepLinkScheme("ctox"));
    assert.isTrue(Option.isNone(parseDesktopDeepLink("ctox://invite/abc123")));
  });
});

describe("parseDesktopDeepLink", () => {
  it("normalizes both scheme families onto one internal representation", () => {
    const fromWorkjet = parseDesktopDeepLink("workjet://app/settings/connections?tab=ssh#top");
    const fromLegacy = parseDesktopDeepLink("t3code://app/settings/connections?tab=ssh#top");

    assert.isTrue(Option.isSome(fromWorkjet));
    assert.isTrue(Option.isSome(fromLegacy));
    assert.equal(
      Option.getOrThrow(fromWorkjet).canonicalUrl,
      Option.getOrThrow(fromLegacy).canonicalUrl,
    );
    assert.equal(
      Option.getOrThrow(fromWorkjet).canonicalUrl,
      "t3code://app/settings/connections?tab=ssh#top",
    );
  });

  it.each([
    ["workjet://app/x", "workjet", false, "t3code://app/x"],
    ["workjet-dev://app/x", "workjet", true, "t3code-dev://app/x"],
    ["workjet-preview://app/x", "workjet", false, "t3code://app/x"],
    ["ctox-desktop://app/x", "ctox", false, "t3code://app/x"],
    ["ctox-desktop-dev://app/x", "ctox", true, "t3code-dev://app/x"],
    ["t3code://app/x", "legacy", false, "t3code://app/x"],
    ["t3code-dev://app/x", "legacy", true, "t3code-dev://app/x"],
  ] as const)("parses %s", (raw, family, isDevelopment, canonicalUrl) => {
    const link = Option.getOrThrow(parseDesktopDeepLink(raw));
    assert.equal(link.family, family);
    assert.equal(link.isDevelopment, isDevelopment);
    assert.equal(link.canonicalUrl, canonicalUrl);
  });

  it("keeps an empty path canonical", () => {
    const link = Option.getOrThrow(parseDesktopDeepLink("workjet://app"));
    assert.equal(link.path, "/");
    assert.equal(link.canonicalUrl, "t3code://app/");
  });

  it("preserves query and fragment separately", () => {
    const link = Option.getOrThrow(parseDesktopDeepLink("workjet://app/a/b?x=1&y=2#/deep"));
    assert.equal(link.path, "/a/b");
    assert.equal(link.search, "?x=1&y=2");
    assert.equal(link.hash, "#/deep");
  });

  it("normalizes a Workjet thread reference onto the renderer thread route", () => {
    const link = Option.getOrThrow(
      parseDesktopDeepLink("workjet://app/threads/environment-1/thread-1"),
    );
    assert.equal(link.path, "/environment-1/thread-1");
    assert.equal(link.canonicalUrl, "t3code://app/environment-1/thread-1");
  });

  it("accepts an upper-case scheme as delivered by some launchers", () => {
    const link = Option.getOrThrow(parseDesktopDeepLink("WORKJET://app/x"));
    assert.equal(link.scheme, "workjet");
    assert.equal(link.canonicalUrl, "t3code://app/x");
  });

  it.each([
    "https://app/x",
    "workjet:/app/x",
    "workjet://evil.example.com/x",
    "workjet://app:8080/x",
    "workjet://user:pw@app/x",
    "t3code-preview://app/x",
    "",
    "://app",
  ])("rejects %s", (raw) => {
    assert.isTrue(Option.isNone(parseDesktopDeepLink(raw)));
  });
});

describe("resolveDesktopDeepLinkRedirect", () => {
  it("redirects a Workjet-scheme link onto the renderer origin", () => {
    assert.deepEqual(
      resolveDesktopDeepLinkRedirect("workjet://app/threads?id=1"),
      Option.some("t3code://app/threads?id=1"),
    );
    assert.deepEqual(
      resolveDesktopDeepLinkRedirect("workjet-dev://app/threads"),
      Option.some("t3code-dev://app/threads"),
    );
  });

  it("does not redirect a link already on the renderer origin", () => {
    assert.isTrue(Option.isNone(resolveDesktopDeepLinkRedirect("t3code://app/threads")));
  });

  it("redirects renderer-scheme thread references onto the canonical route", () => {
    assert.deepEqual(
      resolveDesktopDeepLinkRedirect("t3code://app/threads/environment-1/thread-1"),
      Option.some("t3code://app/environment-1/thread-1"),
    );
  });

  it("does not redirect a foreign url", () => {
    assert.isTrue(Option.isNone(resolveDesktopDeepLinkRedirect("https://example.com/")));
  });
});
