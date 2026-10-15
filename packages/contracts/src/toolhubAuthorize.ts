// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Authorization origins of the providers whose official MCP server the CTOX
 * Toolhub connects (`connect: "mcp"` in the Schnittstellen catalog).
 *
 * The in-app login window only ever shows pages of the selected instance's
 * origin or of the origins listed here for the toolkit being connected; every
 * other top-level navigation and every popup to another origin is blocked.
 * The list is fixed in the app, never taken from the instance or the provider.
 */
export const TOOLHUB_AUTHORIZE_ORIGINS: Readonly<Record<string, ReadonlyArray<string>>> = {
  cloudflare: ["https://mcp.cloudflare.com", "https://dash.cloudflare.com"],
  "cloudflare-bindings": ["https://bindings.mcp.cloudflare.com", "https://dash.cloudflare.com"],
  vercel: ["https://mcp.vercel.com", "https://vercel.com"],
};

export function toolhubAuthorizeOrigins(toolkit: string): ReadonlyArray<string> {
  return Object.hasOwn(TOOLHUB_AUTHORIZE_ORIGINS, toolkit)
    ? (TOOLHUB_AUTHORIZE_ORIGINS[toolkit] ?? [])
    : [];
}
