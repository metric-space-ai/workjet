import { WorkjetLumaSnapshot } from "@workjet/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Zuletzt gelesene Presets je Instanz (localStorage). Die Presets-Seite zeigt
 * sie sofort, bis die Instanz antwortet; gespeichert wird erst gegen den
 * frischen Stand. Nur erfolgreich gelesene Stände werden geschrieben.
 */
const KEY_PREFIX = "workjet.presets.v1:";
const SnapshotJson = Schema.fromJsonString(WorkjetLumaSnapshot);
const decode = Schema.decodeUnknownOption(SnapshotJson);
const encode = Schema.encodeUnknownOption(SnapshotJson);

export function presetSnapshotCacheKey(environmentId: string, instanceId: string): string {
  return `${KEY_PREFIX}${environmentId}:${instanceId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCachedPresetSnapshot(
  environmentId: string,
  instanceId: string,
): WorkjetLumaSnapshot | null {
  try {
    const raw = storage()?.getItem(presetSnapshotCacheKey(environmentId, instanceId));
    return raw ? Option.getOrNull(decode(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCachedPresetSnapshot(
  environmentId: string,
  instanceId: string,
  snapshot: WorkjetLumaSnapshot,
): void {
  try {
    const encoded = encode(snapshot);
    if (Option.isSome(encoded))
      storage()?.setItem(presetSnapshotCacheKey(environmentId, instanceId), encoded.value);
  } catch {
    // Speicher voll oder gesperrt: dann eben ohne Rückfall.
  }
}
