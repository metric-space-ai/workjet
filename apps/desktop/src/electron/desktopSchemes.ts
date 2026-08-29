import productIdentity from "../../product-identity.json" with { type: "json" };

// Pure scheme identity for the desktop app. Kept free of the `electron`
// import so the deep-link parser and tests can use it without an Electron
// runtime. Product identity itself is shared with the packager through the
// checked-in JSON contract above.

export const DESKTOP_HOST = "app";

// Workjet is both the renderer origin and the only product deep-link identity.
// Retired desktop schemes are intentionally not registered or parsed. A link
// produced for an obsolete app must fail closed instead of silently selecting
// a compatibility runtime.
export const WORKJET_PRODUCTION_SCHEME = productIdentity.productionScheme;
export const WORKJET_DEVELOPMENT_SCHEME = productIdentity.developmentScheme;
export const DESKTOP_PRODUCTION_SCHEME = WORKJET_PRODUCTION_SCHEME;
export const DESKTOP_DEVELOPMENT_SCHEME = WORKJET_DEVELOPMENT_SCHEME;

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getWorkjetDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? WORKJET_DEVELOPMENT_SCHEME : WORKJET_PRODUCTION_SCHEME;
}

/**
 * The one deep-link scheme claimed by one build variant.
 */
export function getDesktopDeepLinkSchemes(isDevelopment: boolean): readonly string[] {
  return isDevelopment ? [WORKJET_DEVELOPMENT_SCHEME] : [WORKJET_PRODUCTION_SCHEME];
}

/** Every scheme this app claims, across both build variants. */
export const DESKTOP_DEEP_LINK_SCHEMES: readonly string[] = [
  WORKJET_PRODUCTION_SCHEME,
  WORKJET_DEVELOPMENT_SCHEME,
];

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}
