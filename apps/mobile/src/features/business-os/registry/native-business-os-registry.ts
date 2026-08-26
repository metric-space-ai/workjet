import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { EnvironmentId } from "@t3tools/contracts";

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

const SECRET_PREFIX = "workjet.business-os.secret.";
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
