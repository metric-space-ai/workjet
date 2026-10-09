import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import {
  DesktopLocalServiceSession,
  LocalServiceSessionError,
} from "../backend/DesktopLocalServiceSession.ts";
import { resolveProvisioningBackendBearerToken } from "./CtoxProvisioningEnvironment.ts";

vi.mock("electron", () => ({ safeStorage: {} }));

const legacy: DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  args: [],
  env: {},
  extendEnv: true,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    workjetHome: "/profile",
    host: "127.0.0.1",
    desktopBootstrapToken: "rejected-service-bootstrap",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};
const packaged = {
  ...legacy,
  localSession: { baseDir: "/profile", serverVersion: "1.2.3" },
};
const forbiddenBootstrap = HttpClient.make(() =>
  Effect.die("Protected service provisioning must not request a bootstrap exchange."),
);

describe("worker-source provisioning backend authority", () => {
  it.effect("uses the existing protected session for the exact packaged backend config", () =>
    Effect.gen(function* () {
      let calls = 0;
      const token = yield* resolveProvisioningBackendBearerToken(packaged).pipe(
        Effect.provideService(DesktopLocalServiceSession, {
          attach: () => Effect.die("Provisioning must not attach another service."),
          get: (config) =>
            Effect.sync(() => {
              assert.strictEqual(config, packaged);
              calls++;
              return "protected-service-bearer";
            }),
        }),
        Effect.provideService(HttpClient.HttpClient, forbiddenBootstrap),
      );
      assert.equal(token, "protected-service-bearer");
      assert.equal(calls, 1);
    }),
  );

  it.effect("keeps a protected-session denial and never tries the stale bootstrap credential", () =>
    Effect.gen(function* () {
      const denied = new LocalServiceSessionError({ operation: "unlock" });
      const error = yield* resolveProvisioningBackendBearerToken(packaged).pipe(
        Effect.provideService(DesktopLocalServiceSession, {
          attach: () => Effect.die("No replacement attachment is permitted."),
          get: () => Effect.fail(denied),
        }),
        Effect.provideService(HttpClient.HttpClient, forbiddenBootstrap),
        Effect.flip,
      );
      assert.strictEqual(error, denied);
    }),
  );

  it.effect("preserves the legacy pool bootstrap without enrolling a service", () =>
    Effect.gen(function* () {
      let calls = 0;
      const token = yield* resolveProvisioningBackendBearerToken(legacy).pipe(
        Effect.provideService(DesktopLocalServiceSession, {
          attach: () => Effect.die("Legacy provisioning must not attach a service."),
          get: () => Effect.die("Legacy provisioning must not enroll a protected session."),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            calls++;
            assert.equal(request.url, "http://127.0.0.1:3773/oauth/token");
            assert.equal(request.method, "POST");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "legacy-bearer",
                  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "orchestration:read",
                }),
              ),
            );
          }),
        ),
      );
      assert.equal(token, "legacy-bearer");
      assert.equal(calls, 1);
    }),
  );
});
