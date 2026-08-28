import * as SQLite from "expo-sqlite";

import { MOBILE_DATABASE_NAME } from "../../../persistence/mobile-database";
import { decodeBusinessOsHomeLayout, type BusinessOsHomeLayout } from "./business-os-home-layout";

export interface BusinessOsRecentApp {
  readonly appId: string;
  readonly lastOpenedAtMs: number;
}

interface StoredHomeState {
  readonly layout: BusinessOsHomeLayout | null;
  readonly recents: readonly BusinessOsRecentApp[];
}

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;

async function database() {
  databasePromise ??= SQLite.openDatabaseAsync(MOBILE_DATABASE_NAME);
  const value = await databasePromise;
  await value.execAsync(`
    CREATE TABLE IF NOT EXISTS business_os_home_state (
      instance_id TEXT PRIMARY KEY NOT NULL,
      layout_json TEXT,
      recents_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return value;
}

export function decodeBusinessOsRecents(payload: string): readonly BusinessOsRecentApp[] {
  const value = JSON.parse(payload) as unknown;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Business OS recents are invalid.");
  }
  const ids = new Set<string>();
  const safeId = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
  return Object.freeze(
    value.map((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("appId" in entry) ||
        !("lastOpenedAtMs" in entry) ||
        typeof entry.appId !== "string" ||
        !safeId.test(entry.appId) ||
        ids.has(entry.appId) ||
        !Number.isSafeInteger(entry.lastOpenedAtMs) ||
        Number(entry.lastOpenedAtMs) < 0
      ) {
        throw new Error("Business OS recent app is invalid.");
      }
      ids.add(entry.appId);
      return Object.freeze({ appId: entry.appId, lastOpenedAtMs: Number(entry.lastOpenedAtMs) });
    }),
  );
}

export function addBusinessOsRecent(
  recents: readonly BusinessOsRecentApp[],
  appId: string,
  now = Date.now(),
): readonly BusinessOsRecentApp[] {
  return Object.freeze(
    [{ appId, lastOpenedAtMs: now }, ...recents.filter((entry) => entry.appId !== appId)].slice(
      0,
      16,
    ),
  );
}

export const nativeBusinessOsHomeStore = {
  async load(instanceId: string): Promise<StoredHomeState> {
    const row = await (
      await database()
    ).getFirstAsync<{ readonly layoutJson: string | null; readonly recentsJson: string }>(
      `SELECT layout_json AS layoutJson, recents_json AS recentsJson
       FROM business_os_home_state
       WHERE instance_id = ?`,
      instanceId,
    );
    if (!row) return { layout: null, recents: Object.freeze([]) };
    try {
      return {
        layout: row.layoutJson ? decodeBusinessOsHomeLayout(row.layoutJson) : null,
        recents: decodeBusinessOsRecents(row.recentsJson),
      };
    } catch {
      return { layout: null, recents: Object.freeze([]) };
    }
  },

  async save(input: {
    readonly instanceId: string;
    readonly layout: BusinessOsHomeLayout;
    readonly recents: readonly BusinessOsRecentApp[];
  }): Promise<void> {
    await (
      await database()
    ).runAsync(
      `INSERT INTO business_os_home_state (instance_id, layout_json, recents_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (instance_id) DO UPDATE SET
         layout_json = excluded.layout_json,
         recents_json = excluded.recents_json,
         updated_at = excluded.updated_at`,
      input.instanceId,
      JSON.stringify(input.layout),
      JSON.stringify(input.recents),
      Date.now(),
    );
  },

  async remove(instanceId: string): Promise<void> {
    await (
      await database()
    ).runAsync("DELETE FROM business_os_home_state WHERE instance_id = ?", instanceId);
  },
};
