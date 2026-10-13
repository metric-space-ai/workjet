/**
 * Durable copies of the last confirmed meeting, deck and narration, so the
 * meeting room renders at once instead of waiting for a chain of CTOX
 * round trips. Every entry is a value CTOX already confirmed. Readers show
 * the copy first and replace it with the fresh answer when that arrives.
 * A failing store is never an error: the room then waits for CTOX as before.
 */
export interface JourFixeCacheBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const DATABASE_NAME = "workjet-jour-fixe-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "entries";

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME);
    });
    request.addEventListener("error", () => reject(request.error ?? new Error("open failed")));
    request.addEventListener("success", () => resolve(request.result));
  }).catch((error: unknown) => {
    database = null;
    throw error;
  });
  return database;
}

const indexedDbBackend: JourFixeCacheBackend = {
  async get(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("success", () => resolve(request.result));
    });
  },
  async set(key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("complete", () => resolve());
      transaction.objectStore(STORE_NAME).put(value, key);
    });
  },
};

let backend: JourFixeCacheBackend = indexedDbBackend;

/** Tests replace the store; production always uses IndexedDB. */
export function setJourFixeCacheBackend(next: JourFixeCacheBackend | null) {
  backend = next ?? indexedDbBackend;
}

export async function readJourFixeCache<T>(key: string): Promise<T | undefined> {
  try {
    const value = await backend.get(key);
    return value === undefined || value === null ? undefined : (value as T);
  } catch {
    return undefined;
  }
}

export async function writeJourFixeCache(key: string, value: unknown): Promise<void> {
  try {
    await backend.set(key, value);
  } catch {
    // A full or blocked store only costs the shortcut, never the meeting.
  }
}

export const jourFixeCacheKey = {
  meeting: (instanceId: string, projectId: string, meetingId?: string) =>
    `meeting:${instanceId}:${projectId}:${meetingId ?? ""}`,
  presentation: (instanceId: string, projectId: string, meetingId: string) =>
    `presentation:${instanceId}:${projectId}:${meetingId}`,
  narration: (
    instanceId: string,
    projectId: string,
    meetingId: string,
    deckRevision: number,
    slideId: string,
  ) => `narration:${instanceId}:${projectId}:${meetingId}:${deckRevision}:${slideId}`,
};
