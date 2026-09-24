import type { ProviderDriverKind } from "@workjet/contracts";

/** Only the provider's durable conversation identity crosses the native claim ledger. */
export function ctoxCrewResumeIdentity(
  provider: ProviderDriverKind,
  cursor: unknown,
): string | null {
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return null;
  const record = cursor as Record<string, unknown>;
  let identity: unknown;
  switch (provider) {
    case "codex":
      identity = record.threadId;
      break;
    case "grok":
    case "cursor":
    case "opencode":
      if (record.schemaVersion !== 1) return null;
      identity = record.sessionId;
      break;
    case "claudeAgent":
      identity = record.resume;
      if (
        typeof identity !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity)
      )
        return null;
      break;
    default:
      return null;
  }
  return typeof identity === "string" &&
    identity.trim() === identity &&
    identity.length >= 1 &&
    identity.length <= 256
    ? identity
    : null;
}
