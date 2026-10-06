// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { MessageId, type ThreadId } from "@workjet/contracts";

export function stableSessionImportId(seed: string): string {
  const hex = NodeCrypto.createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export function importedSessionMessageIds(
  threadId: ThreadId,
  receipts: ReadonlyArray<{ readonly sourceKey: string; readonly importedMessageCount: number }>,
): ReadonlyArray<MessageId> {
  return receipts.flatMap((receipt) => {
    // Legacy receipts use the candidate key alone; project copies add ":projectId".
    const seed = receipt.sourceKey.includes(":")
      ? `${receipt.sourceKey}:${threadId}`
      : receipt.sourceKey;
    return Array.from({ length: receipt.importedMessageCount }, (_, index) =>
      MessageId.make(stableSessionImportId(`message:${seed}:${index}`)),
    );
  });
}
