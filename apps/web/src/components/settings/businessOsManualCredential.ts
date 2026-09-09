import {
  WorkjetManagedDeviceInviteManualConnectionResult,
  type CtoxManualPairingImportInput,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

const prefix = "workjet-join-v1.";
const credentialJson = Schema.fromJsonString(WorkjetManagedDeviceInviteManualConnectionResult);

/** The copied password carries the existing invitation proof, not a new grant. */
export function encodeBusinessOsManualCredential(
  connection: WorkjetManagedDeviceInviteManualConnectionResult,
): string {
  const text = Schema.encodeSync(credentialJson)(connection);
  const bytes = new TextEncoder().encode(text);
  return prefix + btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export function decodeBusinessOsManualCredential(input: {
  readonly signalingUrls: string;
  readonly room: string;
  readonly password: string;
  readonly displayName?: string;
  readonly now?: number;
}): CtoxManualPairingImportInput {
  const password = input.password.trim();
  if (!password.startsWith(prefix) || password.length > 131_072) {
    throw new Error(
      "Kopiere das Verbindungspasswort unter „Gerät hinzufügen → Manuell verbinden“ auf einem bereits verbundenen Gerät.",
    );
  }
  let connection: WorkjetManagedDeviceInviteManualConnectionResult;
  try {
    const bytes = Uint8Array.from(atob(password.slice(prefix.length)), (character) =>
      character.charCodeAt(0),
    );
    connection = Schema.decodeUnknownSync(credentialJson)(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("Das Verbindungspasswort ist ungültig oder unvollständig.");
  }
  const expiresAt = Date.parse(connection.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now())) {
    throw new Error(
      "Das Verbindungspasswort ist abgelaufen. Erstelle auf dem verbundenen Gerät eine neue Einladung.",
    );
  }
  const urls = input.signalingUrls
    .split(/[\n,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const canonical = (values: readonly string[]) =>
    [...new Set(values.map((value) => new URL(value).href))].sort().join("\n");
  let matches = false;
  try {
    matches = canonical(urls) === canonical(connection.signalingUrls);
  } catch {
    /* Invalid addresses are reported without echoing credentials. */
  }
  if (!matches || input.room.trim() !== connection.room) {
    throw new Error("Server, Raum und Passwort müssen aus derselben Einladung stammen.");
  }
  return {
    displayName: input.displayName?.trim() || "Verbundene Instanz",
    syncRoom: connection.room,
    signalingUrls: [...connection.signalingUrls],
    signalingAuthVersion: connection.authVersion,
    browserToken: connection.browserToken,
    browserTokenHash: connection.browserTokenHash,
    nativeTokenHash: connection.nativeTokenHash,
    capabilityExpiresAtMs: expiresAt,
  };
}
