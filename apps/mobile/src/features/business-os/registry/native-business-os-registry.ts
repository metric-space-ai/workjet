import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { EnvironmentId } from "@t3tools/contracts";
import type { WorkjetManagedDeviceSessionAuthorization } from "@t3tools/client-runtime/state/business-os-managed-backend-control";

import { uuidv4 } from "../../../lib/uuid";
import { MOBILE_DATABASE_NAME } from "../../../persistence/mobile-database";
import {
  assertBusinessOsMetadataSafe,
  type BusinessOsInstance,
  type BusinessOsRegistryPort,
  type BusinessOsSecretStorePort,
} from "./business-os-registry";
import {
  createBusinessOsEnvironmentBinding,
  type BusinessOsEnvironmentBinding,
} from "./business-os-environment-binding";
import type { WorkjetDeviceSessionStoreDependencies } from "../../pairing/workjet-device-session-store";
import type { ValidatedBusinessOsInvite } from "../pairing/invite";

const SECRET_PREFIX = "workjet.business-os.secret.";
const DEVICE_SESSION_SECRET_PREFIX = "workjet.business-os.device-session.";
let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;

async function database() {
  databasePromise ??= SQLite.openDatabaseAsync(MOBILE_DATABASE_NAME);
  const value = await databasePromise;
  await value.execAsync(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS business_os_instances (
      id TEXT PRIMARY KEY NOT NULL,
      instance_id TEXT NOT NULL UNIQUE,
      metadata TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_os_state (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      selected_instance_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_os_environment_bindings (
      business_os_instance_id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL UNIQUE,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (business_os_instance_id) REFERENCES business_os_instances(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS business_os_instance_environment_memberships (
      business_os_instance_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (business_os_instance_id, environment_id),
      FOREIGN KEY (business_os_instance_id) REFERENCES business_os_instances(id) ON DELETE CASCADE
    );
    INSERT OR IGNORE INTO business_os_instance_environment_memberships (
      business_os_instance_id,
      environment_id,
      updated_at
    )
    SELECT business_os_instance_id, environment_id, updated_at
    FROM business_os_environment_bindings;
    DROP TABLE business_os_environment_bindings;
    DELETE FROM business_os_instance_environment_memberships
    WHERE rowid NOT IN (
      SELECT MAX(rowid)
      FROM business_os_instance_environment_memberships
      GROUP BY environment_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS business_os_environment_owner
      ON business_os_instance_environment_memberships(environment_id);
    CREATE TABLE IF NOT EXISTS business_os_device_sessions (
      business_os_instance_id TEXT PRIMARY KEY NOT NULL,
      secret_reference TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return value;
}

function decodeInstance(payload: string): BusinessOsInstance {
  const parsed = JSON.parse(payload) as BusinessOsInstance;
  assertBusinessOsMetadataSafe(parsed);
  return Object.freeze({
    ...parsed,
    signalingUrls: Object.freeze([...parsed.signalingUrls]),
    user: Object.freeze({ ...parsed.user }),
  });
}

export const nativeBusinessOsRegistry: BusinessOsRegistryPort = {
  async list() {
    const rows = await (
      await database()
    ).getAllAsync<{ readonly metadata: string }>(
      "SELECT metadata FROM business_os_instances ORDER BY updated_at DESC",
    );
    return rows.map((row) => decodeInstance(row.metadata));
  },
  async save(instance) {
    assertBusinessOsMetadataSafe(instance);
    await (
      await database()
    ).runAsync(
      `INSERT INTO business_os_instances (id, instance_id, metadata, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         instance_id = excluded.instance_id,
         metadata = excluded.metadata,
         updated_at = excluded.updated_at`,
      instance.id,
      instance.instanceId,
      JSON.stringify(instance),
      instance.updatedAtMs,
    );
  },
  async remove(id) {
    await (await database()).runAsync("DELETE FROM business_os_instances WHERE id = ?", id);
  },
};

export const nativeBusinessOsSelection = {
  async load(): Promise<string | null> {
    const row = await (
      await database()
    ).getFirstAsync<{ readonly selectedInstanceId: string | null }>(
      `SELECT selected_instance_id AS selectedInstanceId
       FROM business_os_state
       WHERE singleton = 1`,
    );
    return row?.selectedInstanceId ?? null;
  },
  async save(instanceId: string | null): Promise<void> {
    await (
      await database()
    ).runAsync(
      `INSERT INTO business_os_state (singleton, selected_instance_id, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET
         selected_instance_id = excluded.selected_instance_id,
         updated_at = excluded.updated_at`,
      instanceId,
      Date.now(),
    );
  },
};

export const nativeBusinessOsEnvironmentBindings = {
  async list(): Promise<readonly BusinessOsEnvironmentBinding[]> {
    const rows = await (
      await database()
    ).getAllAsync<{
      readonly businessOsInstanceId: string;
      readonly environmentId: string;
    }>(
      `SELECT business_os_instance_id AS businessOsInstanceId,
              environment_id AS environmentId
       FROM business_os_instance_environment_memberships
       ORDER BY updated_at DESC`,
    );
    return rows.map((row) =>
      createBusinessOsEnvironmentBinding(
        row.businessOsInstanceId,
        EnvironmentId.make(row.environmentId),
      ),
    );
  },
  async save(binding: BusinessOsEnvironmentBinding): Promise<void> {
    await (
      await database()
    ).runAsync(
      `INSERT INTO business_os_instance_environment_memberships (
         business_os_instance_id,
         environment_id,
         updated_at
       ) VALUES (?, ?, ?)
       ON CONFLICT (environment_id) DO UPDATE SET
         business_os_instance_id = excluded.business_os_instance_id,
         updated_at = excluded.updated_at`,
      binding.businessOsInstanceId,
      binding.environmentId,
      Date.now(),
    );
  },
  async removeByBusinessOsInstanceId(businessOsInstanceId: string): Promise<void> {
    await (
      await database()
    ).runAsync(
      "DELETE FROM business_os_instance_environment_memberships WHERE business_os_instance_id = ?",
      businessOsInstanceId,
    );
  },
  async replaceForBusinessOsInstance(
    businessOsInstanceId: string,
    environmentIds: readonly EnvironmentId[],
  ): Promise<void> {
    const db = await database();
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        "DELETE FROM business_os_instance_environment_memberships WHERE business_os_instance_id = ?",
        businessOsInstanceId,
      );
      for (const environmentId of new Set(environmentIds)) {
        await db.runAsync(
          `INSERT INTO business_os_instance_environment_memberships (
             business_os_instance_id,
             environment_id,
             updated_at
           ) VALUES (?, ?, ?)
           ON CONFLICT (environment_id) DO UPDATE SET
             business_os_instance_id = excluded.business_os_instance_id,
             updated_at = excluded.updated_at`,
          businessOsInstanceId,
          environmentId,
          Date.now(),
        );
      }
    });
  },
};

export const nativeBusinessOsSecretStore: BusinessOsSecretStorePort = {
  async write(value) {
    const reference = `${SECRET_PREFIX}${uuidv4()}`;
    await SecureStore.setItemAsync(reference, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return reference;
  },
  read(reference) {
    return SecureStore.getItemAsync(reference);
  },
  async remove(reference) {
    await SecureStore.deleteItemAsync(reference);
  },
};

export const nativeWorkjetDeviceSessionStore: WorkjetDeviceSessionStoreDependencies = {
  references: {
    async read(businessOsInstanceId) {
      const row = await (
        await database()
      ).getFirstAsync<{ readonly secretReference: string }>(
        `SELECT secret_reference AS secretReference
         FROM business_os_device_sessions
         WHERE business_os_instance_id = ?`,
        businessOsInstanceId,
      );
      return row?.secretReference ?? null;
    },
    async replace(businessOsInstanceId, secretReference) {
      const db = await database();
      let previousReference: string | null = null;
      await db.withTransactionAsync(async () => {
        const previous = await db.getFirstAsync<{ readonly secretReference: string }>(
          `SELECT secret_reference AS secretReference
           FROM business_os_device_sessions
           WHERE business_os_instance_id = ?`,
          businessOsInstanceId,
        );
        previousReference = previous?.secretReference ?? null;
        await db.runAsync(
          `INSERT INTO business_os_device_sessions (
             business_os_instance_id,
             secret_reference,
             updated_at
           ) VALUES (?, ?, ?)
           ON CONFLICT (business_os_instance_id) DO UPDATE SET
             secret_reference = excluded.secret_reference,
             updated_at = excluded.updated_at`,
          businessOsInstanceId,
          secretReference,
          Date.now(),
        );
      });
      return previousReference;
    },
    async remove(businessOsInstanceId) {
      const db = await database();
      let previousReference: string | null = null;
      await db.withTransactionAsync(async () => {
        const previous = await db.getFirstAsync<{ readonly secretReference: string }>(
          `SELECT secret_reference AS secretReference
           FROM business_os_device_sessions
           WHERE business_os_instance_id = ?`,
          businessOsInstanceId,
        );
        previousReference = previous?.secretReference ?? null;
        await db.runAsync(
          "DELETE FROM business_os_device_sessions WHERE business_os_instance_id = ?",
          businessOsInstanceId,
        );
      });
      return previousReference;
    },
  },
  secrets: {
    async write(value) {
      const reference = `${DEVICE_SESSION_SECRET_PREFIX}${uuidv4()}`;
      await SecureStore.setItemAsync(reference, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      return reference;
    },
    read(reference) {
      return SecureStore.getItemAsync(reference);
    },
    async remove(reference) {
      await SecureStore.deleteItemAsync(reference);
    },
  },
};

/**
 * Commits the CTOX sync credentials, Workjet device session, membership, and
 * active selection as one SQLite reference transaction. Secret values are
 * prepared in SecureStore first and old generations are deleted only after the
 * reference transaction succeeds.
 */
export async function commitNativeManagedWorkjetPairing(input: {
  readonly invite: ValidatedBusinessOsInvite;
  readonly authorization: WorkjetManagedDeviceSessionAuthorization;
  readonly environmentIds: readonly EnvironmentId[];
  readonly now?: number;
}): Promise<BusinessOsInstance> {
  if (input.authorization.businessOsInstanceId !== input.invite.instanceId) {
    throw new Error("Workjet session and CTOX invite name different Business OS instances.");
  }
  const now = input.now ?? Date.now();
  const existing = (await nativeBusinessOsRegistry.list()).find(
    (instance) => instance.instanceId === input.invite.instanceId,
  );
  const newReferences: string[] = [];
  try {
    newReferences.push(await nativeBusinessOsSecretStore.write(input.invite.password));
    newReferences.push(
      await nativeBusinessOsSecretStore.write(input.invite.session.capabilityToken),
    );
    newReferences.push(
      await nativeWorkjetDeviceSessionStore.secrets.write(JSON.stringify(input.authorization)),
    );
  } catch (cause) {
    await Promise.allSettled(
      newReferences.map((reference) =>
        reference.startsWith(DEVICE_SESSION_SECRET_PREFIX)
          ? nativeWorkjetDeviceSessionStore.secrets.remove(reference)
          : nativeBusinessOsSecretStore.remove(reference),
      ),
    );
    throw new Error("Workjet pairing credentials could not be stored securely.", { cause });
  }

  const instance: BusinessOsInstance = Object.freeze({
    id: existing?.id ?? uuidv4(),
    displayName: input.invite.displayName,
    instanceId: input.invite.instanceId,
    syncRoom: input.invite.syncRoom,
    nativePeerId: input.invite.nativePeerId,
    signalingUrls: Object.freeze([...input.invite.signalingUrls]),
    inviteExpiresAt: input.invite.expiresAt,
    capabilityExpiresAtMs: input.invite.session.capabilityExpiresAtMs,
    user: input.invite.session.user,
    roomSecretRef: newReferences[0]!,
    capabilitySecretRef: newReferences[1]!,
    storageIdentity: existing?.storageIdentity ?? uuidv4(),
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  });
  assertBusinessOsMetadataSafe(instance);

  const db = await database();
  let previousSessionReference: string | null = null;
  try {
    await db.withTransactionAsync(async () => {
      const previousSession = await db.getFirstAsync<{ readonly secretReference: string }>(
        `SELECT secret_reference AS secretReference
         FROM business_os_device_sessions
         WHERE business_os_instance_id = ?`,
        input.authorization.businessOsInstanceId,
      );
      previousSessionReference = previousSession?.secretReference ?? null;
      await db.runAsync(
        `INSERT INTO business_os_instances (id, instance_id, metadata, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           instance_id = excluded.instance_id,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`,
        instance.id,
        instance.instanceId,
        JSON.stringify(instance),
        now,
      );
      await db.runAsync(
        `INSERT INTO business_os_device_sessions (
           business_os_instance_id,
           secret_reference,
           updated_at
         ) VALUES (?, ?, ?)
         ON CONFLICT (business_os_instance_id) DO UPDATE SET
           secret_reference = excluded.secret_reference,
           updated_at = excluded.updated_at`,
        input.authorization.businessOsInstanceId,
        newReferences[2]!,
        now,
      );
      await db.runAsync(
        "DELETE FROM business_os_instance_environment_memberships WHERE business_os_instance_id = ?",
        instance.id,
      );
      for (const environmentId of new Set(input.environmentIds)) {
        await db.runAsync(
          `INSERT INTO business_os_instance_environment_memberships (
             business_os_instance_id,
             environment_id,
             updated_at
           ) VALUES (?, ?, ?)
           ON CONFLICT (environment_id) DO UPDATE SET
             business_os_instance_id = excluded.business_os_instance_id,
             updated_at = excluded.updated_at`,
          instance.id,
          environmentId,
          now,
        );
      }
      await db.runAsync(
        `INSERT INTO business_os_state (singleton, selected_instance_id, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET
           selected_instance_id = excluded.selected_instance_id,
           updated_at = excluded.updated_at`,
        instance.id,
        now,
      );
    });
  } catch (cause) {
    await Promise.allSettled([
      nativeBusinessOsSecretStore.remove(newReferences[0]!),
      nativeBusinessOsSecretStore.remove(newReferences[1]!),
      nativeWorkjetDeviceSessionStore.secrets.remove(newReferences[2]!),
    ]);
    throw new Error("Workjet pairing could not be committed atomically.", { cause });
  }

  await Promise.allSettled([
    ...(existing
      ? [
          nativeBusinessOsSecretStore.remove(existing.roomSecretRef),
          nativeBusinessOsSecretStore.remove(existing.capabilitySecretRef),
        ]
      : []),
    ...(previousSessionReference
      ? [nativeWorkjetDeviceSessionStore.secrets.remove(previousSessionReference)]
      : []),
  ]);
  return instance;
}
