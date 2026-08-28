import { isPublicFaviconHost } from "~/browser/browserTargetResolver";

/**
 * Favicon helpers for the preview tab strip.
 *
 * Loads directly from the target origin. This avoids disclosing browsing
 * destinations to a third-party favicon service. Callers render a local
 * fallback when the origin does not expose `/favicon.ico`.
 */
export function faviconUrlForOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.host) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isPublicFaviconHost(url.hostname)) return null;
    return new URL("/favicon.ico", url.origin).href;
  } catch {
    return null;
  }
}
