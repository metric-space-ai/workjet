/** Greppy ACP availability and gateway configuration. */
export const GREPPY_DISABLED_MESSAGE = "Greppy is disabled in Workjet settings.";
export const GREPPY_MISSING_MESSAGE = "Greppy (`greppy`) is not installed or not on PATH.";
export const GREPPY_HTTPS_MESSAGE = "Greppy only reaches plain HTTP gateways.";
export const GREPPY_MODEL_MESSAGE = "Choose a model id available on the Greppy gateway.";
export const GREPPY_TEXT_GENERATION_MESSAGE =
  "Greppy currently supports agent turns, not standalone text generation.";
export const greppyVersionRefusal = (version: string): string =>
  `Greppy ${version} is installed. Workjet requires a 0.4.x build with ACP support.`;
export const greppyInstalledMessage = (version: string): string =>
  `Greppy ${version} with ACP is installed. The gateway is checked when a thread starts.`;

export function plainHttpEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash)
      return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function classifyGreppyVersion(
  output: string,
):
  | { readonly kind: "supported"; readonly version: string }
  | { readonly kind: "unsupported"; readonly version: string }
  | { readonly kind: "unknown" } {
  const version = /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/.exec(output)?.[1];
  if (!version) return { kind: "unknown" };
  return { kind: version.startsWith("0.4.") ? "supported" : "unsupported", version };
}
