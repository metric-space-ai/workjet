import {
  WORKJET_SECRET_VALUE_MAX,
  type WorkjetCredentialRecord,
  type WorkjetSecretRequestRecord,
} from "@workjet/contracts";
import { requestWorkjetProjectControl } from "./workjetProjectControl";
import { newCommandId } from "./lib/utils";

/**
 * Secret requests are read and answered over a dedicated project-control
 * action, never through the chat transcript, drafts or browser storage.
 * Nothing in this module keeps a value after the call returns.
 */
export type SecretRequestOutcome =
  | { readonly ok: true; readonly ref: string | null }
  | { readonly ok: false; readonly reason: string };

export async function listSecretRequests(
  instanceId: string,
  threadKey?: string,
): Promise<readonly WorkjetSecretRequestRecord[] | null> {
  const result = await requestWorkjetProjectControl(instanceId, {
    action: "secret.request.list",
    commandId: newCommandId(),
    status: "pending",
    ...(threadKey ? { threadKey } : {}),
  });
  if (result._tag !== "completed" || result.response.action !== "secret.request.list") return null;
  return result.response.requests;
}

export async function fulfillSecretRequest(
  instanceId: string,
  requestId: string,
  value: string,
): Promise<SecretRequestOutcome> {
  if (value.length === 0 || value.length > WORKJET_SECRET_VALUE_MAX) {
    return { ok: false, reason: "invalid_input" };
  }
  const result = await requestWorkjetProjectControl(instanceId, {
    action: "secret.request.fulfill",
    commandId: newCommandId(),
    requestId,
    value,
  });
  return settle(result);
}

export async function declineSecretRequest(
  instanceId: string,
  requestId: string,
): Promise<SecretRequestOutcome> {
  return settle(
    await requestWorkjetProjectControl(instanceId, {
      action: "secret.request.decline",
      commandId: newCommandId(),
      requestId,
    }),
  );
}

function settle(
  result: Awaited<ReturnType<typeof requestWorkjetProjectControl>>,
): SecretRequestOutcome {
  if (result._tag !== "completed") return { ok: false, reason: result.code };
  const response = result.response;
  if (
    response.action !== "secret.request.fulfill" &&
    response.action !== "secret.request.decline"
  ) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: true, ref: "ref" in response && response.ref ? response.ref : null };
}

export function secretRequestText(language: "de" | "en") {
  const de = language === "de";
  return {
    heading: de ? "Zugangsdaten angefragt" : "Credential requested",
    field: de ? "Wert" : "Value",
    placeholder: de ? "Wert eingeben" : "Enter value",
    store: de ? "Sicher speichern" : "Store securely",
    decline: de ? "Ablehnen" : "Decline",
    replace: de ? "Ersetzen" : "Replace",
    stored: (ref: string) => (de ? `Gespeichert als ${ref}` : `Stored as ${ref}`),
    declined: de ? "Abgelehnt" : "Declined",
    hint: de
      ? "Der Wert geht direkt in den verschlüsselten CTOX-Speicher. Er erscheint nicht im Chat, und der Agent sieht nur den Verweis."
      : "The value goes straight into the encrypted CTOX store. It never appears in the chat, and the agent only sees the reference.",
    failed: de ? "Nicht gespeichert. Erneut versuchen" : "Not stored. Try again",
  };
}

/** Write-only credential listing: names and status, never values. */
export async function listCredentials(
  instanceId: string,
): Promise<readonly WorkjetCredentialRecord[] | null> {
  const result = await requestWorkjetProjectControl(instanceId, {
    action: "secret.list",
    commandId: newCommandId(),
  });
  if (result._tag !== "completed" || result.response.action !== "secret.list") return null;
  return result.response.secrets;
}

export async function putCredential(
  instanceId: string,
  name: string,
  value: string,
): Promise<boolean> {
  if (value.length === 0 || value.length > WORKJET_SECRET_VALUE_MAX) return false;
  const result = await requestWorkjetProjectControl(instanceId, {
    action: "secret.put",
    commandId: newCommandId(),
    name,
    value,
  });
  return result._tag === "completed" && result.response.action === "secret.put";
}

export async function deleteCredential(instanceId: string, name: string): Promise<boolean> {
  const result = await requestWorkjetProjectControl(instanceId, {
    action: "secret.delete",
    commandId: newCommandId(),
    name,
  });
  return result._tag === "completed" && result.response.action === "secret.delete";
}
