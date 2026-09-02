// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxWorkjetSessionTransferEvent } from "@t3tools/contracts";
import { CtoxWorkjetSessionTransferEvent as SessionTransferEventSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CTOX_SESSION_TRANSFER_POST_CHANNEL = "ctox-instance:session-transfer-event";

const decodeTransferEvent = Schema.decodeUnknownSync(SessionTransferEventSchema, {
  onExcessProperty: "error",
});

export class CtoxSessionTransferEventDecoder {
  invalidCount = 0;

  decode(raw: unknown): CtoxWorkjetSessionTransferEvent | undefined {
    try {
      return decodeTransferEvent(raw);
    } catch {
      this.invalidCount += 1;
      return undefined;
    }
  }
}

export function buildSessionTransferEventsRegistrationExpression(
  computerIds: readonly string[],
): string {
  return `(async () => {
  const source = globalThis.workjetSessionEvents;
  if (!source || typeof source.register !== "function") {
    return { registered: 0, events: [] };
  }
  const registration = await source.register({ computerIds: ${JSON.stringify(computerIds)} });
  const snapshot = typeof source.snapshot === "function" ? await source.snapshot() : [];
  return {
    registered: Number.isInteger(registration?.registered) && registration.registered >= 0
      ? registration.registered
      : 0,
    events: Array.isArray(snapshot) ? snapshot : [],
  };
})()`;
}
