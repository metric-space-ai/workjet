import type { ValidatedBusinessOsInvite } from "../pairing/invite";

const FORBIDDEN_METADATA_KEYS = [
  "signaling_room_password",
  "capability_token",
  "ctox_config",
  "desktop_link",
  "password",
  "payload=",
] as const;

export interface BusinessOsInstance {
  readonly id: string;
  readonly displayName: string;
  readonly instanceId: string;
  readonly syncRoom: string;
  readonly nativePeerId: string;
  readonly signalingUrls: readonly string[];
  readonly inviteExpiresAt: string;
  readonly capabilityExpiresAtMs: number;
  readonly user: ValidatedBusinessOsInvite["session"]["user"];
  readonly roomSecretRef: string;
  readonly capabilitySecretRef: string;
  readonly storageIdentity: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface BusinessOsRegistryPort {
  readonly list: () => Promise<readonly BusinessOsInstance[]>;
  readonly save: (instance: BusinessOsInstance) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
}

export interface BusinessOsSecretStorePort {
  readonly write: (value: string) => Promise<string>;
  readonly read: (reference: string) => Promise<string | null>;
  readonly remove: (reference: string) => Promise<void>;
}

export interface BusinessOsProfileStorePort {
  readonly remove: (storageIdentity: string) => Promise<void>;
}

export interface BusinessOsRegistryDependencies {
  readonly registry: BusinessOsRegistryPort;
  readonly secrets: BusinessOsSecretStorePort;
  readonly profiles?: BusinessOsProfileStorePort;
  readonly createOpaqueId: () => string;
  readonly now?: () => number;
}

export interface BusinessOsLaunchSecrets {
  readonly roomPassword: string;
  readonly capabilityToken: string;
}

export class BusinessOsRegistryError extends Error {
  constructor(
    readonly code:
      | "unsafe-metadata"
      | "registry-write"
      | "missing-secret"
      | "secret-write"
      | "profile-delete",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BusinessOsRegistryError";
  }
}

export function assertBusinessOsMetadataSafe(value: unknown): void {
  const inspect = (candidate: unknown): string | null => {
    if (typeof candidate === "string") {
      const lower = candidate.toLowerCase();
      return ["payload=", "ctox_config", "desktop_link"].find((key) => lower.includes(key)) ?? null;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const match = inspect(entry);
        if (match) return match;
      }
      return null;
    }
    if (!candidate || typeof candidate !== "object") return null;
    for (const [key, entry] of Object.entries(candidate)) {
      const lowerKey = key.toLowerCase();
      const forbiddenKey = FORBIDDEN_METADATA_KEYS.find((forbidden) => lowerKey === forbidden);
      if (forbiddenKey) return forbiddenKey;
      const match = inspect(entry);
      if (match) return match;
    }
    return null;
  };
  const forbidden = inspect(value);
  if (forbidden) {
    throw new BusinessOsRegistryError(
      "unsafe-metadata",
      `Business OS metadata contains forbidden credential material: ${forbidden}.`,
    );
  }
}

async function removeBestEffort(
  secrets: BusinessOsSecretStorePort,
  references: readonly string[],
): Promise<void> {
  await Promise.allSettled(references.map((reference) => secrets.remove(reference)));
}

export async function pairBusinessOsInstance(
  invite: ValidatedBusinessOsInvite,
  dependencies: BusinessOsRegistryDependencies,
): Promise<BusinessOsInstance> {
  const now = dependencies.now?.() ?? Date.now();
  const existing = (await dependencies.registry.list()).find(
    (instance) => instance.instanceId === invite.instanceId,
  );
  const newReferences: string[] = [];

  try {
    newReferences.push(await dependencies.secrets.write(invite.password));
    newReferences.push(await dependencies.secrets.write(invite.session.capabilityToken));
  } catch (cause) {
    await removeBestEffort(dependencies.secrets, newReferences);
    throw new BusinessOsRegistryError(
      "secret-write",
      "Business OS credentials could not be stored securely.",
      { cause },
    );
  }

  const instance: BusinessOsInstance = Object.freeze({
    id: existing?.id ?? dependencies.createOpaqueId(),
    displayName: invite.displayName,
    instanceId: invite.instanceId,
    syncRoom: invite.syncRoom,
    nativePeerId: invite.nativePeerId,
    signalingUrls: Object.freeze([...invite.signalingUrls]),
    inviteExpiresAt: invite.expiresAt,
    capabilityExpiresAtMs: invite.session.capabilityExpiresAtMs,
    user: invite.session.user,
    roomSecretRef: newReferences[0]!,
    capabilitySecretRef: newReferences[1]!,
    storageIdentity: existing?.storageIdentity ?? dependencies.createOpaqueId(),
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  });
  assertBusinessOsMetadataSafe(instance);

  try {
    await dependencies.registry.save(instance);
  } catch (cause) {
    await removeBestEffort(dependencies.secrets, newReferences);
    throw new BusinessOsRegistryError(
      "registry-write",
      "Business OS instance metadata could not be stored.",
      { cause },
    );
  }

  if (existing) {
    await removeBestEffort(dependencies.secrets, [
      existing.roomSecretRef,
      existing.capabilitySecretRef,
    ]);
  }
  return instance;
}

export async function loadBusinessOsLaunchSecrets(
  instance: BusinessOsInstance,
  secretStore: BusinessOsSecretStorePort,
): Promise<BusinessOsLaunchSecrets> {
  const [roomPassword, capabilityToken] = await Promise.all([
    secretStore.read(instance.roomSecretRef),
    secretStore.read(instance.capabilitySecretRef),
  ]);
  if (!roomPassword || !capabilityToken) {
    throw new BusinessOsRegistryError(
      "missing-secret",
      "Business OS credentials are incomplete. Pair this backend again.",
    );
  }
  return { roomPassword, capabilityToken };
}

export async function forgetBusinessOsInstance(
  instance: BusinessOsInstance,
  dependencies: BusinessOsRegistryDependencies,
): Promise<void> {
  if (dependencies.profiles) {
    try {
      await dependencies.profiles.remove(instance.storageIdentity);
    } catch (cause) {
      throw new BusinessOsRegistryError(
        "profile-delete",
        "The Business OS web profile could not be removed.",
        { cause },
      );
    }
  }
  await dependencies.registry.remove(instance.id);
  await removeBestEffort(dependencies.secrets, [
    instance.roomSecretRef,
    instance.capabilitySecretRef,
  ]);
}
