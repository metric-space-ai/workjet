import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import * as ElectronProtocol from "../electron/desktopSchemes.ts";
import {
  isDesktopDeepLinkScheme,
  parseDesktopDeepLink,
  resolveDesktopDeepLinkRedirect,
} from "./DesktopDeepLink.ts";

describe("desktop protocol schemes", () => {
  it("claims only the Workjet scheme for each build variant", () => {
    assert.deepEqual(ElectronProtocol.DESKTOP_DEEP_LINK_SCHEMES, ["workjet", "workjet-dev"]);
  });

  it("selects exactly one scheme per build variant", () => {
    assert.deepEqual(ElectronProtocol.getDesktopDeepLinkSchemes(false), ["workjet"]);
    assert.deepEqual(ElectronProtocol.getDesktopDeepLinkSchemes(true), ["workjet-dev"]);
  });

  it("never claims the CTOX daemon's own ctox: namespace", () => {
    assert.isFalse(ElectronProtocol.DESKTOP_DEEP_LINK_SCHEMES.includes("ctox"));
    assert.isFalse(isDesktopDeepLinkScheme("ctox"));
    assert.isTrue(Option.isNone(parseDesktopDeepLink("ctox://invite/abc123")));
  });
});

describe("parseDesktopDeepLink", () => {
  it("keeps the canonical Workjet representation", () => {
    const fromWorkjet = Option.getOrThrow(
      parseDesktopDeepLink("workjet://app/settings/connections?tab=ssh#top"),
    );
    assert.equal(fromWorkjet.canonicalUrl, "workjet://app/settings/connections?tab=ssh#top");
    assert.equal(fromWorkjet.family, "workjet");
  });

  it.each([
    ["workjet://app/x", "workjet", false, "workjet://app/x"],
    ["workjet-dev://app/x", "workjet", true, "workjet-dev://app/x"],
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
    "workjet-preview://app/x",
    "ctox-desktop://app/x",
    "ctox-desktop-dev://app/x",
    "t3code://app/x",
    "t3code-dev://app/x",
    "t3code-preview://app/x",
    "",
    "://app",
  ])("rejects %s", (raw) => {
    assert.isTrue(Option.isNone(parseDesktopDeepLink(raw)));
  });
});

describe("resolveDesktopDeepLinkRedirect", () => {
  it("does not redirect the canonical renderer origin", () => {
    assert.isTrue(Option.isNone(resolveDesktopDeepLinkRedirect("workjet://app/threads")));
    assert.isTrue(Option.isNone(resolveDesktopDeepLinkRedirect("workjet-dev://app/threads")));
  });

  it("does not redirect a foreign url", () => {
    assert.isTrue(Option.isNone(resolveDesktopDeepLinkRedirect("https://example.com/")));
  });
});
