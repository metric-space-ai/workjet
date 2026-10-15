/** Gateway defaults apply to newly created instances; saved instances retain their routing choice. */
export function newInstanceUsesWorkjetGateway(driver: string): boolean {
  return ["claudeAgent", "codex", "grok", "opencode", "minimax", "greppy", "pi"].includes(driver);
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const INSTANCE_ID_MAX_LENGTH = 64;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@workjet/contracts`.
 */
export function slugifyInstanceLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/**
 * Derive the instance id instead of asking for it (UI-Vertrag §3: erkennen
 * statt fragen). The id is the routing key threads and sessions use, so it
 * must be unique on the environment and must never collide with the
 * driver's built-in default slot (whose id is the bare driver name and may
 * not be stored explicitly yet). A label yields "driver_slug"; without a
 * label the first free "driver_n" (n from 2) is used. Collisions get a
 * numeric suffix.
 */
export function deriveProviderInstanceId(
  driver: string,
  label: string,
  existing: ReadonlySet<string>,
): string {
  const slug = slugifyInstanceLabel(label);
  const base = slug ? `${driver}_${slug}` : driver;
  if (slug && !existing.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a German status line (≤12 words), or `null` if valid.
 */
export function validateProviderInstanceId(
  id: string,
  existing: ReadonlySet<string>,
): string | null {
  if (id.length === 0) return "Name fehlt.";
  if (id.length > INSTANCE_ID_MAX_LENGTH) return "Name zu lang.";
  if (!INSTANCE_ID_PATTERN.test(id)) return "Name ungültig.";
  if (existing.has(id)) return "Name bereits vergeben.";
  return null;
}
