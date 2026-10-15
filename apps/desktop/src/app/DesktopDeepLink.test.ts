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
    ]);
  });

  it("prefers the Workjet scheme per build variant and keeps inbound aliases", () => {
    assert.deepEqual(ElectronProtocol.getDesktopDeepLinkSchemes(false), [
      "workjet",
      "ctox-desktop",
    ]);
    assert.deepEqual(ElectronProtocol.getDesktopDeepLinkSchemes(true), [
      "workjet-dev",
      "ctox-desktop-dev",
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
    const fromLegacy = parseDesktopDeepLink("ctox-desktop://app/settings/connections?tab=ssh#top");

    assert.isTrue(Option.isSome(fromWorkjet));
    assert.isTrue(Option.isSome(fromLegacy));
    assert.equal(
      Option.getOrThrow(fromWorkjet).canonicalUrl,
      Option.getOrThrow(fromLegacy).canonicalUrl,
    );
    assert.equal(
      Option.getOrThrow(fromWorkjet).canonicalUrl,
      "workjet://app/settings/connections?tab=ssh#top",
    );
  });

  it.each([
    ["workjet://app/x", "workjet", false, "workjet://app/x"],
    ["workjet-dev://app/x", "workjet", true, "workjet-dev://app/x"],
    ["workjet-preview://app/x", "workjet", false, "workjet://app/x"],
    ["ctox-desktop://app/x", "ctox", false, "workjet://app/x"],
    ["ctox-desktop-dev://app/x", "ctox", true, "workjet-dev://app/x"],
  ] as const)("parses %s", (raw, family, isDevelopment, canonicalUrl) => {
    const link = Option.getOrThrow(parseDesktopDeepLink(raw));
    assert.equal(link.family, family);
    assert.equal(link.isDevelopment, isDevelopment);
    assert.equal(link.canonicalUrl, canonicalUrl);
  });

  it("keeps an empty path canonical", () => {
    const link = Option.getOrThrow(parseDesktopDeepLink("workjet://app"));
    assert.equal(link.path, "/");
    assert.equal(link.canonicalUrl, "workjet://app/");
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
    assert.equal(link.canonicalUrl, "workjet://app/environment-1/thread-1");
  });

  it("accepts an upper-case scheme as delivered by some launchers", () => {
    const link = Option.getOrThrow(parseDesktopDeepLink("WORKJET://app/x"));
    assert.equal(link.scheme, "workjet");
    assert.equal(link.canonicalUrl, "workjet://app/x");
  });

  it.each([
    "https://app/x",
    "workjet:/app/x",
    "workjet://evil.example.com/x",
    "workjet://app:8080/x",
    "workjet://user:pw@app/x",
    "workjet-unknown://app/x",
    "",
    "://app",
  ])("rejects %s", (raw) => {
    assert.isTrue(Option.isNone(parseDesktopDeepLink(raw)));
  });
});

describe("resolveDesktopDeepLinkRedirect", () => {
  it("redirects a CTOX alias onto the Workjet renderer origin", () => {
    assert.deepEqual(
      resolveDesktopDeepLinkRedirect("ctox-desktop://app/threads?id=1"),
      Option.some("workjet://app/threads?id=1"),
    );
    assert.deepEqual(
      resolveDesktopDeepLinkRedirect("ctox-desktop-dev://app/threads"),
      Option.some("workjet-dev://app/threads"),
    );
  });

  it("does not redirect a link already on the renderer origin", () => {
    assert.isTrue(Option.isNone(resolveDesktopDeepLinkRedirect("workjet://app/threads")));
  });

  it("redirects renderer-scheme thread references onto the canonical route", () => {
    assert.deepEqual(
      resolveDesktopDeepLinkRedirect("workjet://app/threads/environment-1/thread-1"),
      Option.some("workjet://app/environment-1/thread-1"),
    );
  });

  it("does not redirect a foreign url", () => {
    assert.isTrue(Option.isNone(resolveDesktopDeepLinkRedirect("https://example.com/")));
  });
});

describe("workjet://pair (CTOX Business OS Sync QR code)", () => {
  // base64url of ["w2", …] as produced by CTOX mobile_invites.rs; only its
  // shape matters here, the importer validates the contents.
  const payload = "WyJ3MiIsIk9wZXJhdGlvbnMiXQ";

  it("opens Einstellungen › Instanzen with the link prefilled, never importing", () => {
    const link = Option.getOrThrow(parseDesktopDeepLink(`workjet://pair?payload=${payload}`));
    assert.equal(link.path, "/index.html");
    assert.equal(link.search, "");
    assert.equal(link.hash, `#/settings/business-os?add=link&payload=${payload}`);
    assert.equal(
      link.canonicalUrl,
      `workjet://app/index.html#/settings/business-os?add=link&payload=${payload}`,
    );
  });

  it("is not mistaken for the Clerk OAuth callback on the renderer origin", () => {
    const link = Option.getOrThrow(parseDesktopDeepLink(`workjet://pair/?payload=${payload}`));
    assert.notEqual(link.path, "/");
  });

  it("normalizes the dev and legacy schemes onto the renderer origin", () => {
    assert.equal(
      Option.getOrThrow(parseDesktopDeepLink(`workjet-dev://pair?payload=${payload}`)).canonicalUrl,
      `workjet-dev://app/index.html#/settings/business-os?add=link&payload=${payload}`,
    );
    assert.deepEqual(
      resolveDesktopDeepLinkRedirect(`ctox-desktop://pair?payload=${payload}`),
      Option.some(`workjet://app/index.html#/settings/business-os?add=link&payload=${payload}`),
    );
  });

  it.each([
    "workjet://pair",
    "workjet://pair?payload=",
    `workjet://pair?payload=${payload}&payload=${payload}`,
    `workjet://pair?payload=${payload}&add=manual`,
    "workjet://pair?payload=a%2Bb",
    `workjet://pair/extra?payload=${payload}`,
    `workjet://pair?payload=${payload}#x`,
    `workjet://pair:1234?payload=${payload}`,
    `workjet://user@pair?payload=${payload}`,
    `workjet://pair?payload=${"a".repeat(4097)}`,
  ])("rejects malformed pair link %s", (raw) => {
    assert.isTrue(Option.isNone(parseDesktopDeepLink(raw)));
  });
});
