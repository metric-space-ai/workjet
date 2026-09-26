import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@workjet/contracts";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";
import * as DesktopLocalServiceSession from "./DesktopLocalServiceSession.ts";
vi.mock("electron", () => ({ safeStorage: {} }));

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    workjetHome: "/tmp/workjet",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect(
    "uses the protected session path on each request and never falls back to bootstrap on denial",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        let deny = false;
        const pool = {
          list: Effect.succeed([
            {
              id: PRIMARY_LOCAL_ENVIRONMENT_ID,
              currentConfig: Effect.succeed(
                Option.some({
                  ...config,
                  localSession: { baseDir: "/profile", serverVersion: "1.2.3" },
                }),
              ),
            },
          ]),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"];
        const auth = yield* DesktopLocalEnvironmentAuth.make.pipe(
          Effect.provideService(DesktopBackendPool.DesktopBackendPool, pool),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("No bootstrap request is permitted.")),
          ),
          Effect.provideService(DesktopLocalServiceSession.DesktopLocalServiceSession, {
            get: () =>
              Effect.suspend(() => {
                requests++;
                return deny
                  ? Effect.fail(
                      new DesktopLocalServiceSession.LocalServiceSessionError({
                        operation: "unlock",
                      }),
                    )
                  : Effect.succeed("protected-token");
              }),
          }),
        );
        assert.equal(yield* auth.getBearerToken, "protected-token");
        assert.equal(yield* auth.getBearerToken, "protected-token");
        deny = true;
        assert.equal(
          (yield* auth.getBearerToken.pipe(Effect.flip))._tag,
          "LocalServiceSessionError",
        );
        assert.equal(requests, 3);
      }),
  );
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "desktop-bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      );
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeed(Option.some(config)),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            poolLayer,
            httpClientLayer,
            Layer.succeed(DesktopLocalServiceSession.DesktopLocalServiceSession, {
              get: () => Effect.die("Legacy bootstrap must not enroll a local service session."),
            }),
          ),
        ),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );
});
