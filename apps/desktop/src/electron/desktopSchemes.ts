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

// The CTOX-branded deep-link schemes. These are what the OS hands back to the
// app (mac CFBundleURLTypes, Linux x-scheme-handler, Windows protocol client).
// They are deliberately NOT `ctox:` — that namespace belongs to the CTOX
// daemon's own instance/pairing/invite links, which this app must never claim.
export const CTOX_DESKTOP_PRODUCTION_SCHEME = "ctox-desktop";
export const CTOX_DESKTOP_DEVELOPMENT_SCHEME = "ctox-desktop-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getCtoxDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? CTOX_DESKTOP_DEVELOPMENT_SCHEME : CTOX_DESKTOP_PRODUCTION_SCHEME;
}

/**
 * Deep-link schemes for one build variant, preferred scheme first. The legacy
 * t3code entry stays claimed so links baked into older docs and OAuth consoles
 * keep opening the app.
 */
export function getDesktopDeepLinkSchemes(isDevelopment: boolean): readonly string[] {
  return [getCtoxDesktopScheme(isDevelopment), getDesktopScheme(isDevelopment)];
}

/** Every scheme this app claims, across both build variants. */
export const DESKTOP_DEEP_LINK_SCHEMES: readonly string[] = [
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
