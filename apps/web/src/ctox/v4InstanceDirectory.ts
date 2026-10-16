// Instance directory on this device (contract E54.5 §3). An entry is created locally from the
// launch context a redeemed invitation returned and refreshed on every `device.launch.renew`. It
// is the durable record that this device is paired with that instance; the server-side `devices`
// collection (administration, revocation) is not its source. Entries survive restarts, so a
// selection of a paired V4 instance is kept and renewed instead of being dropped.
import type { V4LaunchContext } from "./kernel/index";
import type { V4InviteSignalingTarget } from "./v4DeviceInvite";

export interface V4InstanceDirectoryEntry {
  readonly instanceId: string;
  readonly displayName: string;
  readonly userId: string;
  readonly role: string;
  /** `hello.offer.device_proof.device_id` of the latest launch context (signed by the Core). */
  readonly deviceId: string;
  /** Signaling target of the latest launch context; renewal joins it as a pairing peer. */
  readonly signaling: V4InviteSignalingTarget;
  /** `unpaired` after `device_revoked`/`device_unknown`: no further renewal until a new link. */
  readonly state: "paired" | "unpaired";
  readonly updatedAtMs: number;
}

export interface V4InstanceDirectoryStorage {
  readonly load: () => Promise<ReadonlyArray<V4InstanceDirectoryEntry>>;
  readonly save: (entries: ReadonlyArray<V4InstanceDirectoryEntry>) => Promise<void>;
}

type Listener = () => void;

const INDEX_KEY = "workjet.v4.instanceDirectory.ids";
let storage: V4InstanceDirectoryStorage | null = null;
let entries = new Map<string, V4InstanceDirectoryEntry>();
let loaded: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<Listener>();

/**
 * Instance ids only (no secrets), mirrored synchronously so that a selection restored at start
 * is recognised before the asynchronous directory load finished.
 */
function readIndex(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(INDEX_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}
function writeIndex() {
  try {
    globalThis.localStorage?.setItem(INDEX_KEY, JSON.stringify([...entries.keys()]));
  } catch {
    // The index is a start-up hint only; the directory itself lives in `storage`.
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096;

function validEntry(value: unknown): value is V4InstanceDirectoryEntry {
  if (!isRecord(value) || !isRecord(value.signaling)) return false;
  const target = value.signaling;
  return (
    text(value.instanceId) &&
    text(value.displayName) &&
    text(value.userId) &&
    text(value.role) &&
    text(value.deviceId) &&
    (value.state === "paired" || value.state === "unpaired") &&
    typeof value.updatedAtMs === "number" &&
    Array.isArray(target.urls) &&
    target.urls.length > 0 &&
    target.urls.every(text) &&
    text(target.room) &&
    text(target.nativePeerId) &&
    (target.token === undefined || text(target.token)) &&
    Array.isArray(target.iceServers)
  );
}

function notify() {
  for (const listener of listeners) listener();
}

function persist(): Promise<void> {
  writeIndex();
  const snapshot = [...entries.values()];
  const target = storage;
  writes = writes.then(
    () => target?.save(snapshot),
    () => target?.save(snapshot),
  );
  return writes;
}

export function configureV4InstanceDirectoryStorage(next: V4InstanceDirectoryStorage): void {
  storage = next;
  loaded = null;
}

/** Loads the durable directory once (later calls share the first load). */
export function loadV4InstanceDirectory(): Promise<void> {
  storage ??= createIndexedDbV4InstanceDirectoryStorage();
  const source = storage;
  return (loaded ??= source.load().then(
    (stored) => {
      const next = new Map<string, V4InstanceDirectoryEntry>();
      for (const entry of stored) if (validEntry(entry)) next.set(entry.instanceId, entry);
      // Entries written in this session before the load finished win over stored ones.
      for (const [id, entry] of entries) next.set(id, entry);
      entries = next;
      writeIndex();
      notify();
    },
    () => {
      loaded = null;
    },
  ));
}

export function readV4InstanceDirectory(): ReadonlyArray<V4InstanceDirectoryEntry> {
  return [...entries.values()];
}

export function getV4InstanceDirectoryEntry(
  instanceId: string,
): V4InstanceDirectoryEntry | undefined {
  return entries.get(instanceId);
}

/** Synchronous: true for a paired V4 instance of this device (also before the load finished). */
export function isV4DirectoryInstance(instanceId: string | null): boolean {
  if (instanceId === null) return false;
  return entries.has(instanceId) || (loaded === null && readIndex().has(instanceId));
}

export function subscribeV4InstanceDirectory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Creates or refreshes the entry from a launch context (redeem or renew). */
export function recordV4LaunchContext(
  context: Readonly<V4LaunchContext["v4"]>,
  nowMs: number,
): Promise<V4InstanceDirectoryEntry> {
  const previous = entries.get(context.instanceId);
  const entry: V4InstanceDirectoryEntry = {
    instanceId: context.instanceId,
    displayName: previous?.displayName ?? context.instanceId,
    userId: context.userId,
    role: context.actor.role,
    deviceId: context.hello.offer.device_proof.device_id,
    signaling: {
      urls: [...context.signaling.urls],
      room: context.signaling.room,
      nativePeerId: context.signaling.nativePeerId,
      token: context.signaling.token,
      iceServers: context.signaling.iceServers.map((server) => ({ ...server })),
    },
    state: "paired",
    updatedAtMs: nowMs,
  };
  entries.set(entry.instanceId, entry);
  notify();
  return persist().then(() => entry);
}

/** `device_revoked`/`device_unknown`: the device is no longer paired with this instance. */
export function markV4DeviceUnpaired(instanceId: string, nowMs: number): Promise<void> {
  const entry = entries.get(instanceId);
  if (entry === undefined || entry.state === "unpaired") return Promise.resolve();
  entries.set(instanceId, { ...entry, state: "unpaired", updatedAtMs: nowMs });
  notify();
  return persist();
}

export function createMemoryV4InstanceDirectoryStorage(
  initial: ReadonlyArray<V4InstanceDirectoryEntry> = [],
): V4InstanceDirectoryStorage & { readonly saved: () => ReadonlyArray<V4InstanceDirectoryEntry> } {
  let saved: ReadonlyArray<V4InstanceDirectoryEntry> = structuredClone([...initial]);
  return {
    load: async () => structuredClone([...saved]),
    save: async (next) => {
      saved = structuredClone([...next]);
    },
    saved: () => saved,
  };
}

const DB_NAME = "workjet-v4-instance-directory";
const STORE = "directory";
const KEY = "entries";

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("indexeddb_failed"));
  });
}

export function createIndexedDbV4InstanceDirectoryStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): V4InstanceDirectoryStorage {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (factory === undefined) return Promise.reject(new Error("indexeddb_unavailable"));
    return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
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
  };
  return {
    load: async () => {
      const db = await open();
      const value: unknown = await request(
        db.transaction(STORE, "readonly").objectStore(STORE).get(KEY),
      );
      return Array.isArray(value) ? value.filter(validEntry) : [];
    },
    save: async (next) => {
      const db = await open();
      await request(db.transaction(STORE, "readwrite").objectStore(STORE).put([...next], KEY));
    },
  };
}

/** Test seam. */
export function resetV4InstanceDirectory(next?: V4InstanceDirectoryStorage): void {
  storage = next ?? null;
  entries = new Map();
  loaded = null;
  writes = Promise.resolve();
  listeners.clear();
  try {
    globalThis.localStorage?.removeItem(INDEX_KEY);
  } catch {}
}
