export type WorkjetLinkVariant = "production" | "development" | "preview";

const CANONICAL_SCHEMES: Record<WorkjetLinkVariant, string> = {
  production: "workjet",
  development: "workjet-dev",
  preview: "workjet-preview",
};

const LEGACY_SCHEME_VARIANTS: Readonly<Record<string, WorkjetLinkVariant>> = {
  "ctox-mobile": "production",
  "ctox-mobile-dev": "development",
  "ctox-mobile-preview": "preview",
  t3code: "production",
  "t3code-dev": "development",
  "t3code-preview": "preview",
};

export function buildWorkjetUrl(
  path: string,
  options: { readonly variant?: WorkjetLinkVariant; readonly query?: URLSearchParams } = {},
): string {
  const normalizedPath = path.replace(/^\/+/, "");
  if (!normalizedPath || normalizedPath.includes("://")) {
    throw new Error("Workjet link path is invalid.");
  }
  const scheme = CANONICAL_SCHEMES[options.variant ?? "production"];
  const query = options.query?.toString();
  return `${scheme}://${normalizedPath}${query ? `?${query}` : ""}`;
}

/**
 * Converts accepted migration aliases to the canonical Workjet route before
 * navigation sees them. The payload itself is never decoded or logged here.
 */
export function normalizeIncomingWorkjetUrl(raw: string): string {
  const input = raw.trim();
  if (!input) return input;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === "ctox-business-os-mobile") {
    if (url.hostname !== "pair" || (url.pathname && url.pathname !== "/")) return input;
    if (url.username || url.password) return input;
    // Preserve every component so the invite validator can reject unexpected
    // parameters or fragments instead of normalization accidentally hiding them.
    return `workjet://business-os/pair${url.search}${url.hash}`;
  }

  const variant = LEGACY_SCHEME_VARIANTS[scheme];
  if (!variant) return input;
  return input.replace(/^[a-z][a-z0-9+.-]*:/iu, `${CANONICAL_SCHEMES[variant]}:`);
}

export function isBusinessOsPairLink(raw: string): boolean {
  try {
    const url = new URL(normalizeIncomingWorkjetUrl(raw));
    return (
      Object.values(CANONICAL_SCHEMES).includes(url.protocol.slice(0, -1)) &&
      url.hostname === "business-os" &&
      url.pathname === "/pair" &&
      url.searchParams.has("payload")
    );
  } catch {
    return false;
  }
}
