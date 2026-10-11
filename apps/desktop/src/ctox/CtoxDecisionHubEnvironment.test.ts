import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import {
  DesktopLocalServiceSession,
  LocalServiceSessionError,
} from "../backend/DesktopLocalServiceSession.ts";
import {
  DesktopConnectionCatalogStoreProtectionError,
  DesktopConnectionCatalogStoreReadError,
} from "../app/DesktopConnectionCatalogStore.ts";
let makeDecisionHubEnvironmentResolver: (typeof import("./CtoxDecisionHubEnvironment.ts"))["makeDecisionHubEnvironmentResolver"];
beforeEach(async () => {
  vi.resetModules();
  ({ makeDecisionHubEnvironmentResolver } = await import("./CtoxDecisionHubEnvironment.ts"));
});

const fakeSafeStorage = vi.hoisted(() => ({
  decryptString: vi.fn((_bytes: Uint8Array): string => {
    throw new Error("fixture decryption failure");
  }),
}));
vi.mock("electron", () => ({ safeStorage: fakeSafeStorage }));
vi.mock("@workjet/client-runtime/environment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workjet/client-runtime/environment")>()),
  fetchRemoteEnvironmentDescriptor: () => Effect.succeed({ environmentId: "fixture-local" }),
}));

const config: DesktopBackendStartConfig = {
  executablePath: "/fixture/electron",
  entryPath: "/fixture/server.mjs",
  cwd: "/fixture",
  args: [],
  env: {},
  extendEnv: true,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    workjetHome: "/fixture",
    host: "127.0.0.1",
    desktopBootstrapToken: "unused-fixture-bootstrap",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
  localSession: { baseDir: "/fixture", serverVersion: "1.2.3" },
};
const noNetwork = HttpClient.make(() =>
  Effect.die("No live network is permitted in this fixture."),
);
const session = {
  attach: () => Effect.die("Do not attach or unlock a real service."),
  get: () => Effect.succeed("fixture-local-bearer"),
};
const unreadable = Effect.try({
  try: () => fakeSafeStorage.decryptString(new Uint8Array([1, 2, 3])),
  catch: (cause) =>
    new DesktopConnectionCatalogStoreProtectionError({
      operation: "decrypt-catalog",
      catalogPath: "/fixture/catalog.enc",
      cause,
    }),
}).pipe(Effect.map(Option.some));

describe("decision hub local environment fallback", () => {
  for (const [name, readCatalog] of [
    ["fake safe-storage decryption", unreadable],
    [
      "catalog read",
      Effect.fail(
        new DesktopConnectionCatalogStoreReadError({
          catalogPath: "/fixture/catalog.enc",
          cause: new Error("fixture read failure"),
        }),
      ),
    ],
    ["catalog decoding", Effect.succeed(Option.some("unreadable fixture JSON"))],
  ] as const) {
    it.effect(
      `recovers from ${name} and reports it once across resolver instances without rewriting the catalog`,
      () =>
        Effect.gen(function* () {
          let notifications = 0;
          let localReads = 0;
          const createResolver = () =>
            makeDecisionHubEnvironmentResolver({
              readCatalog: readCatalog as Effect.Effect<
                Option.Option<string>,
                | DesktopConnectionCatalogStoreProtectionError
                | DesktopConnectionCatalogStoreReadError
              >,
              localConfigurations: Effect.sync(() => {
                localReads++;
                return [config];
              }),
              notifyCatalogError: Effect.sync(() => {
                notifications++;
              }),
            });
          for (let attempt = 0; attempt < 2; attempt++) {
            const resolve = yield* createResolver();
            const environment = yield* resolve("fixture-local").pipe(
              Effect.provideService(HttpClient.HttpClient, noNetwork),
              Effect.provideService(DesktopLocalServiceSession, session),
            );
            expect(environment).toEqual({
              httpBaseUrl: "http://127.0.0.1:3773/",
              wsBaseUrl: "ws://127.0.0.1:3773/",
              bearerToken: "fixture-local-bearer",
            });
          }
          expect(notifications).toBe(1);
          expect(localReads).toBe(2);
        }),
    );
  }
  it.effect(
    "does not grant a different environment or bypass a protected local-session denial",
    () =>
      Effect.gen(function* () {
        const resolve = yield* makeDecisionHubEnvironmentResolver({
          readCatalog: unreadable,
          localConfigurations: Effect.succeed([config]),
          notifyCatalogError: Effect.void,
        });
        const foreign = yield* resolve("fixture-foreign").pipe(
          Effect.provideService(HttpClient.HttpClient, noNetwork),
          Effect.provideService(DesktopLocalServiceSession, session),
          Effect.flip,
        );
        expect(foreign).toBe("environment_unavailable");
        const denied = new LocalServiceSessionError({ operation: "unlock" });
        const failure = yield* resolve("fixture-local").pipe(
          Effect.provideService(HttpClient.HttpClient, noNetwork),
          Effect.provideService(DesktopLocalServiceSession, {
            ...session,
            get: () => Effect.fail(denied),
          }),
          Effect.flip,
        );
        expect(failure).toBe(denied);
      }),
  );
  it.effect("continues local resolution even if the warning surface fails", () =>
    Effect.gen(function* () {
      const resolve = yield* makeDecisionHubEnvironmentResolver({
        readCatalog: unreadable,
        localConfigurations: Effect.succeed([config]),
        notifyCatalogError: Effect.die("fixture UI unavailable"),
      });
      expect(
        (yield* resolve("fixture-local").pipe(
          Effect.provideService(HttpClient.HttpClient, noNetwork),
          Effect.provideService(DesktopLocalServiceSession, session),
        )).bearerToken,
      ).toBe("fixture-local-bearer");
    }),
  );
});
