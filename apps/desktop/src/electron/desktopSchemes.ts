// Pure scheme identity for the desktop app. Kept free of the `electron`
// import so the deep-link parser, the packaging scripts, and the tests can use
// it without an Electron runtime.

export const DESKTOP_HOST = "app";

// The renderer is served from these schemes. They stay on the historical
// t3code names because the origin is part of the backend CORS allowlist
// (apps/server DESKTOP_RENDERER_ORIGINS) and of every persisted renderer
// storage partition — renaming the *serving* origin is a separate migration.
export const DESKTOP_PRODUCTION_SCHEME = "t3code";
export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";

// Workjet is the only user-facing app identity. These are the only schemes new
// links may emit. Preview is claimed as well so preview/mobile-generated links
// open an installed desktop client instead of falling through to a browser.
export const WORKJET_PRODUCTION_SCHEME = "workjet";
export const WORKJET_DEVELOPMENT_SCHEME = "workjet-dev";
export const WORKJET_PREVIEW_SCHEME = "workjet-preview";

// Older CTOX Desktop builds emitted these. They remain inbound aliases only.
// They are deliberately NOT `ctox:` — that namespace belongs to the CTOX
// daemon's own instance/pairing/invite links, which Workjet must never claim.
export const CTOX_DESKTOP_PRODUCTION_SCHEME = "ctox-desktop";
export const CTOX_DESKTOP_DEVELOPMENT_SCHEME = "ctox-desktop-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getWorkjetDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? WORKJET_DEVELOPMENT_SCHEME : WORKJET_PRODUCTION_SCHEME;
}

/**
 * Deep-link schemes for one build variant, preferred scheme first. CTOX and
 * t3code entries stay claimed only so links baked into older docs and OAuth
 * consoles keep opening Workjet.
 */
export function getDesktopDeepLinkSchemes(isDevelopment: boolean): readonly string[] {
  return isDevelopment
    ? [WORKJET_DEVELOPMENT_SCHEME, CTOX_DESKTOP_DEVELOPMENT_SCHEME, DESKTOP_DEVELOPMENT_SCHEME]
    : [WORKJET_PRODUCTION_SCHEME, CTOX_DESKTOP_PRODUCTION_SCHEME, DESKTOP_PRODUCTION_SCHEME];
}

/** Every scheme this app claims, across both build variants. */
export const DESKTOP_DEEP_LINK_SCHEMES: readonly string[] = [
  WORKJET_PRODUCTION_SCHEME,
  WORKJET_DEVELOPMENT_SCHEME,
  WORKJET_PREVIEW_SCHEME,
  CTOX_DESKTOP_PRODUCTION_SCHEME,
  CTOX_DESKTOP_DEVELOPMENT_SCHEME,
  DESKTOP_PRODUCTION_SCHEME,
  DESKTOP_DEVELOPMENT_SCHEME,
];

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}
