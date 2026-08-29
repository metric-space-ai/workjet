import * as Option from "effect/Option";

import * as DesktopSchemes from "../electron/desktopSchemes.ts";

/**
 * Workjet is the only desktop deep-link family.
 */
export type DesktopDeepLinkFamily = "workjet";

export interface DesktopDeepLink {
  /** Scheme exactly as it arrived, without the trailing colon. */
  readonly scheme: string;
  /** Scheme the renderer is served from for this link's build variant. */
  readonly canonicalScheme: string;
  readonly family: DesktopDeepLinkFamily;
  readonly isDevelopment: boolean;
  /** Path portion, always starting with `/`. */
  readonly path: string;
  /** Query string including the leading `?`, or an empty string. */
  readonly search: string;
  /** Fragment including the leading `#`, or an empty string. */
  readonly hash: string;
  /**
   * The single internal representation every caller works with: the same link
   * expressed on the renderer's serving origin for this build variant.
   */
  readonly canonicalUrl: string;
}

interface SchemeDescriptor {
  readonly family: DesktopDeepLinkFamily;
  readonly isDevelopment: boolean;
}

const SCHEME_DESCRIPTORS: ReadonlyMap<string, SchemeDescriptor> = new Map([
  [DesktopSchemes.WORKJET_PRODUCTION_SCHEME, { family: "workjet", isDevelopment: false }],
  [DesktopSchemes.WORKJET_DEVELOPMENT_SCHEME, { family: "workjet", isDevelopment: true }],
] satisfies ReadonlyArray<readonly [string, SchemeDescriptor]>);

export function isDesktopDeepLinkScheme(scheme: string): boolean {
  return SCHEME_DESCRIPTORS.has(scheme.replace(/:$/, "").toLowerCase());
}

/**
 * Parse an OS-delivered deep link. Returns `none` for anything that is not one
 * of this app's Workjet schemes, or that targets a host other than the app host —
 * a foreign host must never be normalized onto the renderer origin.
 *
 * The production and development schemes are registered as *standard* schemes (see
 * registerDesktopSchemePrivilegesSync), but this parser must also work in the
 * plain-Node test process and before Electron is ready, so it never relies on
 * Chromium's URL parser having the scheme registered.
 */
export function parseDesktopDeepLink(rawUrl: string): Option.Option<DesktopDeepLink> {
  const trimmed = rawUrl.trim();
  const schemeSeparator = trimmed.indexOf(":");
  if (schemeSeparator <= 0) return Option.none();

  const scheme = trimmed.slice(0, schemeSeparator).toLowerCase();
  const descriptor = SCHEME_DESCRIPTORS.get(scheme);
  if (descriptor === undefined) return Option.none();

  // Re-express on https so hosts, paths, queries, and fragments are parsed by
  // the standard-scheme rules regardless of scheme registration.
  const remainder = trimmed.slice(schemeSeparator + 1);
  if (!remainder.startsWith("//")) return Option.none();

  let parsed: URL;
  try {
    parsed = new URL(`https:${remainder}`);
  } catch {
    return Option.none();
  }

  if (parsed.hostname !== DesktopSchemes.DESKTOP_HOST) return Option.none();
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return Option.none();

  const canonicalScheme = DesktopSchemes.getDesktopScheme(descriptor.isDevelopment);
  const path = parsed.pathname === "" ? "/" : parsed.pathname;

  return Option.some({
    scheme,
    canonicalScheme,
    family: descriptor.family,
    isDevelopment: descriptor.isDevelopment,
    path,
    search: parsed.search,
    hash: parsed.hash,
    canonicalUrl: `${canonicalScheme}://${DesktopSchemes.DESKTOP_HOST}${path}${parsed.search}${parsed.hash}`,
  });
}

/**
 * The canonical URL for a link that arrived on a scheme the renderer is not
 * served from. Returns `none` when the link is already canonical (or is not a
 * desktop deep link at all), so callers can treat `some` as "redirect needed".
 */
export function resolveDesktopDeepLinkRedirect(rawUrl: string): Option.Option<string> {
  return parseDesktopDeepLink(rawUrl).pipe(
    Option.filter((link) => link.scheme !== link.canonicalScheme),
    Option.map((link) => link.canonicalUrl),
  );
}
