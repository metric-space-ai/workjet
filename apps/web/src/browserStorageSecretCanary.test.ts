/**
 * THE BROWSER-STORAGE CANARY.
 *
 * `docs/workjet-plan.md` carries the invariant "no raw provider, pairing,
 * capability, sudo, or SSH secrets in Git, browser storage, thread events,
 * instance registries, logs, crash reports, or support bundles". BROWSER
 * STORAGE was one of the two sinks on that list with no test: the desktop's
 * instance registry is proven clean by `CtoxInstanceRegistry.test.ts`, but
 * nothing checked what the renderer itself leaves behind in `localStorage` and
 * IndexedDB.
 *
 * This drives the REAL persistence path, not a stand-in for it:
 *
 *  - `apps/web/src/connection/storage.ts` → `connectionStorageLayer`, the
 *    IndexedDB layer that persists the connection catalog (targets, profiles,
 *    credentials, relay DPoP tokens) and the per-environment cache, including
 *    the cached `ServerConfig` — which carries `providers`, and is therefore
 *    the one place a provider secret could plausibly reach the browser.
 *  - `apps/web/src/clientPersistenceStorage.ts` and
 *    `apps/web/src/uiStateStore.ts`, the two `localStorage` writers.
 *
 * Only the browser ENGINE is emulated: a `Map`-backed `Storage` (the
 * convention `clientPersistenceStorage.test.ts` and `uiStateStore.test.ts`
 * already use, since the unit project runs in `environment: "node"`) and a
 * minimal in-memory IndexedDB. Everything above the engine — the Effect layer,
 * the schemas, the catalog document, the encoders — is the shipping code. A
 * canary that scanned a storage stub of its own construction would prove only
 * that the stub is clean.
 *
 * WHAT IS ALLOWED TO BE THERE. Three values in this dump are entropic on
 * purpose and are declared below with a reason each. The rest of the dump must
 * be free of every shape in `@t3tools/shared/secretShapes` — the same table the
 * support-bundle gate redacts with and the tracked-file gate scans with.
 *
 * NOT COVERED, deliberately: the DPoP signing key in
 * `apps/web/src/cloud/dpop.ts`. It is stored as a non-extractable `CryptoKey`
 * handle (`importJWK(…, { extractable: false })`), so the key material cannot
 * be read back out of IndexedDB by construction, and the access token that
 * accompanies it IS covered here through `RemoteDpopAccessTokenStore`. Cached
 * thread and shell snapshots are also out of scope: they carry the user's own
 * conversation text, which the app is required to persist verbatim.
 */
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  ConnectionRegistrationStore,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  BROWSER_STORAGE_SECRET_SHAPES,
  findSecretShapeMatches,
} from "@t3tools/shared/secretShapes";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const ENVIRONMENT_ID = EnvironmentId.make("env-canary");
const CONNECTION_ID = "conn-canary";

/**
 * The three entropic values this dump is ALLOWED to contain, each with the
 * reason it belongs there. `occurrences` is asserted exactly: a credential that
 * turns up twice has been copied into a second store, which is how a
 * "credentials live in exactly one place" design quietly stops being true.
 */
const DECLARED_BROWSER_CREDENTIALS = [
  {
    name: "connection bearer credential",
    value: "t3cbt7Qk2Lm4Rt8Wv6Yb1Nc3Kd5Fg9Hj0PsQwErTyUi",
    occurrences: 1,
    reason:
      "The browser's own session credential for the T3 server the user paired it with, held by `CredentialStore` in the connection catalog. It is the credential the web app exists to use; a browser that cannot keep it cannot stay signed in. It is none of the five kinds the invariant names — it is neither a provider subscription token, nor a CTOX pairing or capability secret, nor a sudo or SSH secret, all of which stay in the owning runtime's secret store.",
  },
  {
    name: "relay DPoP access token",
    value: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJlbnYtY2FuYXJ5In0.9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0Ps",
    occurrences: 1,
    reason:
      "A short-lived relay access token held by `RemoteDpopAccessTokenStore`. It is sender-constrained: without the non-extractable DPoP private key it cannot be replayed, which is the reason the relay design puts it here at all.",
  },
  {
    name: "DPoP public-key thumbprint",
    value: "R4Yb1Nc3Kd5Fg7Hj0PsQwErTyUiOpAsDfGhJkLzXcV",
    occurrences: 1,
    reason:
      "A fingerprint of a PUBLIC key. It is base64url and therefore entropic, which is exactly why a scanner has to be told about it rather than left to guess; it discloses nothing.",
  },
] as const;

// ---------------------------------------------------------------------------
// The browser engine. Not the code under test — the equivalent of the
// `Map`-backed `Storage` the neighbouring persistence tests already install.
// ---------------------------------------------------------------------------

type StoreData = Map<string, Map<IDBValidKey, unknown>>;
const databases = new Map<string, StoreData>();

function makeRequest<T>(run: () => T): IDBRequest<T> {
  const target = new EventTarget();
  const request = {
    result: undefined as T,
    error: null as DOMException | null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  queueMicrotask(() => {
    request.result = run();
    target.dispatchEvent(new Event("success"));
  });
  return request as unknown as IDBRequest<T>;
}

function makeTransaction(stores: StoreData, names: string | Iterable<string>) {
  const target = new EventTarget();
  let settled = false;
  const complete = () => {
    if (settled) return;
    settled = true;
    target.dispatchEvent(new Event("complete"));
  };
  // Individual store operations resolve on the microtask queue, so scheduling
  // `complete` on the macrotask queue reproduces IndexedDB's ordering: every
  // queued write lands before the transaction reports completion.
  setTimeout(complete, 0);
  const name = typeof names === "string" ? names : [...names][0]!;
  const data = stores.get(name) ?? new Map<IDBValidKey, unknown>();
  stores.set(name, data);
  return {
    error: null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    objectStore: () => ({
      get: (key: IDBValidKey) => makeRequest(() => data.get(key)),
      put: (value: unknown, key: IDBValidKey) => makeRequest(() => data.set(key, value)),
      delete: (key: IDBValidKey) => makeRequest(() => data.delete(key)),
      openCursor: () => makeRequest(() => null),
    }),
  };
}

function makeDatabase(name: string) {
  const stores = databases.get(name) ?? new Map<string, Map<IDBValidKey, unknown>>();
  databases.set(name, stores);
  return {
    objectStoreNames: { contains: (storeName: string) => stores.has(storeName) },
    createObjectStore: (storeName: string) => {
      stores.set(storeName, new Map<IDBValidKey, unknown>());
      return {};
    },
    transaction: (names: string | Iterable<string>) => makeTransaction(stores, names),
    close: () => undefined,
  };
}

function installBrowserEngine(): void {
  databases.clear();
  const items = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  };
  const indexedDb = {
    open: (name: string) => {
      const target = new EventTarget();
      const request = {
        result: makeDatabase(name),
        error: null,
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
      };
      queueMicrotask(() => {
        target.dispatchEvent(new Event("upgradeneeded"));
        target.dispatchEvent(new Event("success"));
      });
      return request;
    },
  };
  vi.stubGlobal("window", { localStorage: storage } as unknown as Window & typeof globalThis);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("indexedDB", indexedDb);
  vi.stubGlobal("IDBKeyRange", { bound: (lower: string, upper: string) => ({ lower, upper }) });
}

/** Everything the browser would still hold after the tab closes. */
function dumpBrowserStorage(): string {
  const parts: Array<string> = [];
  const storage = globalThis.localStorage;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    parts.push(`localStorage ${key} = ${storage.getItem(key) ?? ""}`);
  }
  for (const [databaseName, stores] of databases) {
    for (const [storeName, records] of stores) {
      for (const [key, value] of records) {
        parts.push(
          `indexedDB ${databaseName}/${storeName}/${String(key)} = ${
            typeof value === "string" ? value : JSON.stringify(value)
          }`,
        );
      }
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Realistic app state, shaped exactly as the server and the UI produce it.
// ---------------------------------------------------------------------------

const SERVER_CONFIG: ServerConfig = {
  environment: {
    environmentId: ENVIRONMENT_ID,
    label: "Canary",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  // The provider surface is the point of this fixture: a cached ServerConfig
  // is the only route by which a provider account could reach the browser.
  providers: [
    {
      instanceId: ProviderInstanceId.make("claude-code"),
      driver: ProviderDriverKind.make("claude-code"),
      displayName: "Claude Code",
      enabled: true,
      installed: true,
      version: "2.0.0",
      status: "ready",
      auth: { status: "authenticated", type: "subscription", label: "Max" },
      checkedAt: "2026-08-20T10:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

function bearerRegistration(label: string) {
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label,
      connectionId: CONNECTION_ID,
    }),
    profile: new BearerConnectionProfile({
      connectionId: CONNECTION_ID,
      environmentId: ENVIRONMENT_ID,
      label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    credential: new BearerConnectionCredential({
      token: DECLARED_BROWSER_CREDENTIALS[0].value,
    }),
  });
}

/**
 * Drives the shipping persistence path. `connectionStorageLayer` is imported
 * dynamically because it reads `window.desktopBridge` and `indexedDB` while the
 * layer is built, and the engine has to be installed first.
 */
function persistRealisticSession(options: { readonly connectionLabel: string }) {
  return Effect.gen(function* () {
    const { connectionStorageLayer } = yield* Effect.promise(() => import("./connection/storage"));
    const { writeBrowserClientSettings } = yield* Effect.promise(
      () => import("./clientPersistenceStorage"),
    );
    const { persistState } = yield* Effect.promise(() => import("./uiStateStore"));

    writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, timestampFormat: "24-hour" });
    persistState({
      projectExpandedById: { [ProjectId.make("project-1")]: true },
      projectOrder: [ProjectId.make("project-1")],
      threadLastVisitedAtById: { [ThreadId.make("thread-1")]: "2026-08-20T10:00:00.000Z" },
      threadChangedFilesExpandedById: {},
      defaultAdvertisedEndpointKey: null,
    });

    yield* Effect.gen(function* () {
      const registrations = yield* ConnectionRegistrationStore;
      yield* registrations.register(bearerRegistration(options.connectionLabel));

      const tokens = yield* TokenStore.RemoteDpopAccessTokenStore;
      yield* tokens.put(
        new TokenStore.RemoteDpopAccessToken({
          environmentId: ENVIRONMENT_ID,
          label: "Relay",
          endpoint: {
            httpBaseUrl: "https://relay.example.test",
            wsBaseUrl: "wss://relay.example.test",
            providerKind: "t3_relay",
          },
          accessToken: DECLARED_BROWSER_CREDENTIALS[1].value,
          expiresAtEpochMs: 1_800_000_000_000,
          dpopThumbprint: DECLARED_BROWSER_CREDENTIALS[2].value,
        }),
      );

      const cache = yield* EnvironmentCacheStore;
      yield* cache.saveServerConfig(ENVIRONMENT_ID, SERVER_CONFIG);
    }).pipe(Effect.provide(connectionStorageLayer));
  });
}

/**
 * Matches the dump carries that are not one of the declared credentials.
 *
 * Overlap is checked in BOTH directions. A shape can match a fragment of a
 * declared value (`entropy-run` sees only the third segment of a JWT, because
 * `.` is not in its character class) or a span that contains one (an
 * authorization header wrapped around it), and neither is a new leak.
 */
function undeclaredSecretShapes(dump: string) {
  return findSecretShapeMatches(dump, BROWSER_STORAGE_SECRET_SHAPES).filter(
    (match) =>
      !DECLARED_BROWSER_CREDENTIALS.some(
        (declared) => match.match.includes(declared.value) || declared.value.includes(match.match),
      ),
  );
}

describe("browser storage secret canary", () => {
  beforeEach(() => {
    installBrowserEngine();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    databases.clear();
  });

  it.effect("leaves no undeclared secret shape in localStorage or IndexedDB", () =>
    Effect.gen(function* () {
      yield* persistRealisticSession({ connectionLabel: "Workstation" });
      const dump = dumpBrowserStorage();

      expect(dump).toContain("t3code:client-settings:v1");
      expect(dump).toContain("t3code:connection-runtime/catalog");
      expect(dump).toContain("t3code:connection-runtime/server-config");

      const leaks = undeclaredSecretShapes(dump);
      expect(
        leaks.map((leak) => `${leak.shape} @${leak.index}`),
        "browser storage must carry no secret shape beyond the declared session credentials",
      ).toEqual([]);
    }),
  );

  it.effect("keeps every declared credential in exactly one place", () =>
    Effect.gen(function* () {
      yield* persistRealisticSession({ connectionLabel: "Workstation" });
      const dump = dumpBrowserStorage();

      for (const declared of DECLARED_BROWSER_CREDENTIALS) {
        expect(dump.split(declared.value).length - 1, `${declared.name} occurrence count`).toBe(
          declared.occurrences,
        );
        expect(
          declared.reason.length,
          `${declared.name} must say why it is allowed`,
        ).toBeGreaterThan(40);
      }
    }),
  );

  /**
   * THE POSITIVE CONTROL. Without it the two assertions above would also pass
   * against a persistence path that wrote nothing at all, or against a scanner
   * that had quietly stopped matching. A provider key placed in the connection
   * label — an ordinary, user-visible string field, the kind of carrier a real
   * leak travels in — must come back out of the real storage path and be seen.
   */
  it.effect("fails when a provider key travels into storage on an ordinary field", () =>
    Effect.gen(function* () {
      yield* persistRealisticSession({
        connectionLabel: "sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0Ps",
      });
      const leaks = undeclaredSecretShapes(dumpBrowserStorage());

      expect(leaks.map((leak) => leak.shape)).toContain("known-credential");
    }),
  );
});
