export interface NativeDecisionHubNotification {
  readonly kind: "decision_hub";
  readonly title: string;
  readonly body: string;
  readonly tag?: string;
  readonly recordId?: string;
  readonly urgency: "normal" | "high" | "critical";
}

export function decodeNativeDecisionHubNotification(
  value: unknown,
): NativeDecisionHubNotification | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== "decision_hub") return null;
  const title = boundedText(input.title, 160);
  const body = boundedText(input.body, 240);
  if (!title || !body) return null;
  const urgency =
    input.urgency === "high" || input.urgency === "critical" ? input.urgency : "normal";
  const tag = boundedToken(input.tag, 180);
  const recordId = boundedToken(input.recordId, 180);
  return {
    kind: "decision_hub",
    title,
    body,
    urgency,
    ...(tag ? { tag } : {}),
    ...(recordId ? { recordId } : {}),
  };
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim().slice(0, maxLength).trim();
  return text || null;
}

function boundedToken(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token.length > 0 && token.length <= maxLength && /^[A-Za-z0-9._:-]+$/u.test(token)
    ? token
    : null;
}
