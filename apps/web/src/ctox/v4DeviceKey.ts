// Device key for E54.4 pairing: one Ed25519 key per CTOX instance, created on first pairing and
// reused afterwards. The private half is a non-extractable WebCrypto key persisted as a CryptoKey
// in IndexedDB; its bytes never leave WebCrypto. Workjet's existing desktop device-proof key
// (CtoxDeviceProofKey) is P-256 ECDSA in the Main secret registry and cannot satisfy the Ed25519
// contract, so it is deliberately not reused. No OS keychain access happens here.
import { base64UrlEncode, type V4DeviceKeySource } from "./v4DeviceInvite";

export interface V4StoredDeviceKey {
  readonly privateKey: CryptoKey;
  /** Canonical unpadded base64url of the raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
}

export interface V4DeviceKeyStorage {
  readonly get: (instanceId: string) => Promise<V4StoredDeviceKey | undefined>;
  /** Stores only when absent; resolves the key that is stored afterwards (first writer wins). */
  readonly putIfAbsent: (instanceId: string, key: V4StoredDeviceKey) => Promise<V4StoredDeviceKey>;
}

export async function generateV4DeviceKey(
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<V4StoredDeviceKey> {
  const pair = (await subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  if (raw.length !== 32) throw new Error("ed25519_public_key_invalid");
  return { privateKey: pair.privateKey, publicKey: base64UrlEncode(raw) };
}

export function createV4DeviceKeySource(
  storage: V4DeviceKeyStorage,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): V4DeviceKeySource & { readonly keyFor: (instanceId: string) => Promise<V4StoredDeviceKey> } {
  const inflight = new Map<string, Promise<V4StoredDeviceKey>>();
  const keyFor = (instanceId: string) => {
    const running = inflight.get(instanceId);
    if (running) return running;
    const next = (async () => {
      const existing = await storage.get(instanceId);
      if (existing) return existing;
      return storage.putIfAbsent(instanceId, await generateV4DeviceKey(subtle));
    })().finally(() => inflight.delete(instanceId));
    inflight.set(instanceId, next);
    return next;
  };
  return { keyFor, publicKeyFor: async (instanceId) => (await keyFor(instanceId)).publicKey };
}

export function createMemoryV4DeviceKeyStorage(): V4DeviceKeyStorage {
  const keys = new Map<string, V4StoredDeviceKey>();
  return {
    get: async (instanceId) => keys.get(instanceId),
    putIfAbsent: async (instanceId, key) => {
      const existing = keys.get(instanceId);
      if (existing) return existing;
      keys.set(instanceId, key);
      return key;
    },
  };
}

const DB_NAME = "workjet-v4-device-keys";
const STORE = "keys";

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("indexeddb_failed"));
  });
}

export function createIndexedDbV4DeviceKeyStorage(
  factory: IDBFactory = globalThis.indexedDB,
): V4DeviceKeyStorage {
  let database: Promise<IDBDatabase> | null = null;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DB_NAME, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE))
          opening.result.createObjectStore(STORE);
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => {
        database = null;
        reject(opening.error ?? new Error("indexeddb_open_failed"));
      };
    }));
  const valid = (value: unknown): value is V4StoredDeviceKey =>
    value !== null &&
    typeof value === "object" &&
    (value as V4StoredDeviceKey).privateKey instanceof CryptoKey &&
    typeof (value as V4StoredDeviceKey).publicKey === "string";
  return {
    get: async (instanceId) => {
      const db = await open();
      const value = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(instanceId));
      return valid(value) ? value : undefined;
    },
    putIfAbsent: async (instanceId, key) => {
      const db = await open();
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const existing: unknown = await request(store.get(instanceId));
      if (valid(existing)) return existing;
      await request(store.put({ privateKey: key.privateKey, publicKey: key.publicKey }, instanceId));
      return key;
    },
  };
}

let defaultSource: ReturnType<typeof createV4DeviceKeySource> | null = null;
/** The renderer's device key source (IndexedDB-backed). */
export function workjetV4DeviceKeys() {
  return (defaultSource ??= createV4DeviceKeySource(createIndexedDbV4DeviceKeyStorage()));
}
