import type { BusinessOsInstanceId } from "@t3tools/contracts";
import type { WorkjetManagedDeviceSessionAuthorization } from "@t3tools/client-runtime/state/business-os-managed-backend-control";

export interface WorkjetDeviceSessionReferenceStore {
  readonly read: (businessOsInstanceId: BusinessOsInstanceId) => Promise<string | null>;
  readonly replace: (
    businessOsInstanceId: BusinessOsInstanceId,
    secretReference: string,
  ) => Promise<string | null>;
  readonly remove: (businessOsInstanceId: BusinessOsInstanceId) => Promise<string | null>;
}

export interface WorkjetDeviceSessionSecretStore {
  readonly write: (value: string) => Promise<string>;
  readonly read: (reference: string) => Promise<string | null>;
  readonly remove: (reference: string) => Promise<void>;
}

export interface WorkjetDeviceSessionStoreDependencies {
  readonly references: WorkjetDeviceSessionReferenceStore;
  readonly secrets: WorkjetDeviceSessionSecretStore;
}

export class WorkjetDeviceSessionStoreError extends Error {
  constructor(
    readonly code: "encode" | "decode" | "read" | "write" | "remove",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkjetDeviceSessionStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeAuthorization(encoded: string): WorkjetManagedDeviceSessionAuthorization {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch (cause) {
    throw new WorkjetDeviceSessionStoreError(
      "decode",
      "The stored Workjet device session is invalid.",
      { cause },
    );
  }
  if (
    !isRecord(value) ||
    value.tokenType !== "DPoP" ||
    typeof value.sessionIssuer !== "string" ||
    typeof value.relayIssuer !== "string" ||
    !Array.isArray(value.relayScopes) ||
    !value.relayScopes.every((scope) => typeof scope === "string") ||
    typeof value.accessToken !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.refreshGrant !== "string" ||
    typeof value.refreshExpiresAt !== "string" ||
    typeof value.businessOsInstanceId !== "string" ||
    typeof value.deviceId !== "string"
  ) {
    throw new WorkjetDeviceSessionStoreError(
      "decode",
      "The stored Workjet device session is invalid.",
    );
  }
  return value as unknown as WorkjetManagedDeviceSessionAuthorization;
}

function encodeAuthorization(authorization: WorkjetManagedDeviceSessionAuthorization): string {
  try {
    return JSON.stringify(authorization);
  } catch (cause) {
    throw new WorkjetDeviceSessionStoreError(
      "encode",
      "The Workjet device session could not be encoded.",
      { cause },
    );
  }
}

/**
 * Stores one DPoP-bound session per Business OS instance. The secret is written
 * first, then one opaque reference is swapped atomically. A failed swap removes
 * the new secret; the previous session remains usable until the swap succeeds.
 */
export async function saveWorkjetDeviceSession(
  authorization: WorkjetManagedDeviceSessionAuthorization,
  dependencies: WorkjetDeviceSessionStoreDependencies,
): Promise<void> {
  let nextReference: string;
  try {
    nextReference = await dependencies.secrets.write(encodeAuthorization(authorization));
  } catch (cause) {
    throw new WorkjetDeviceSessionStoreError(
      "write",
      "The Workjet device session could not be stored securely.",
      { cause },
    );
  }

  let previousReference: string | null;
  try {
    previousReference = await dependencies.references.replace(
      authorization.businessOsInstanceId,
      nextReference,
    );
  } catch (cause) {
    await dependencies.secrets.remove(nextReference).catch(() => undefined);
    throw new WorkjetDeviceSessionStoreError(
      "write",
      "The Workjet device session reference could not be committed.",
      { cause },
    );
  }

  if (previousReference && previousReference !== nextReference) {
    await dependencies.secrets.remove(previousReference).catch(() => undefined);
  }
}

export async function loadWorkjetDeviceSession(
  businessOsInstanceId: BusinessOsInstanceId,
  dependencies: WorkjetDeviceSessionStoreDependencies,
): Promise<WorkjetManagedDeviceSessionAuthorization | null> {
  let reference: string | null;
  try {
    reference = await dependencies.references.read(businessOsInstanceId);
  } catch (cause) {
    throw new WorkjetDeviceSessionStoreError(
      "read",
      "The Workjet device session reference could not be read.",
      { cause },
    );
  }
  if (!reference) return null;
  let encoded: string | null;
  try {
    encoded = await dependencies.secrets.read(reference);
  } catch (cause) {
    throw new WorkjetDeviceSessionStoreError(
      "read",
      "The Workjet device session could not be read securely.",
      { cause },
    );
  }
  if (!encoded) {
    throw new WorkjetDeviceSessionStoreError(
      "read",
      "The Workjet device session is incomplete. Pair this Business OS again.",
    );
  }
  const authorization = decodeAuthorization(encoded);
  if (authorization.businessOsInstanceId !== businessOsInstanceId) {
    throw new WorkjetDeviceSessionStoreError(
      "decode",
      "The Workjet device session belongs to a different Business OS.",
    );
  }
  return authorization;
}

export async function removeWorkjetDeviceSession(
  businessOsInstanceId: BusinessOsInstanceId,
  dependencies: WorkjetDeviceSessionStoreDependencies,
): Promise<void> {
  let reference: string | null;
  try {
    reference = await dependencies.references.remove(businessOsInstanceId);
  } catch (cause) {
    throw new WorkjetDeviceSessionStoreError(
      "remove",
      "The Workjet device session reference could not be removed.",
      { cause },
    );
  }
  if (reference) await dependencies.secrets.remove(reference).catch(() => undefined);
}
