// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxManagedInstance } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Session } from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({ session: {} }));

import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";
import * as CtoxManagedLaunch from "./CtoxManagedLaunch.ts";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeUnknownSync(UnknownJson);

const descriptor: CtoxManagedInstance = {
  id: "managed:tenant_skf",
  source: "ctox_dev",
  displayName: "SKF",
  status: "available",
  domain: "skf.ctox.dev",
  role: "owner",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: true,
    httpDataProxy: false,
    nativePeerObserved: true,
  },
};

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  };
}

function decodeConfig(launchUrl: string): Record<string, unknown> {
  const packed = new URL(launchUrl).searchParams.get("ctox_config");
  assert.isString(packed);
  return decodeUnknownJson(Buffer.from(packed ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function harness(fetchImpl: ReturnType<typeof vi.fn>, baseUrl = "https://ctox.dev") {
  const accountSession = { fetch: fetchImpl } as unknown as Session;
  const sessions = CtoxElectronSessions.CtoxElectronSessions.of({
    account: Effect.succeed(accountSession),
    instance: () => Effect.die("unused"),
    clearInstance: () => Effect.die("unused"),
  });
  return CtoxManagedLaunch.layer({ baseUrl }).pipe(
    Layer.provide(Layer.succeed(CtoxElectronSessions.CtoxElectronSessions, sessions)),
  );
}

describe("CtoxManagedLaunch", () => {
  it.effect("posts the tenant launch handshake and loads the tenant URL the server names", () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/desktop/launch-token")) {
        return response({ launchConfigUrl: "https://ctox.dev/api/desktop/launch/token_1" });
      }
      return response({
        launchUrl: "https://skf.ctox.dev/legacy",
        pairingConfig: {
          transport: "webrtc",
          http_bridge_available: false,
          sync_room: "ctox-business-os:skf",
          session: { capability_token: "native-secret" },
        },
      });
    });

    return Effect.gen(function* () {
      const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
      const launch = yield* launches.launch(descriptor);
      const url = new URL(launch.launchUrl);
      const config = decodeConfig(launch.launchUrl);

      // The SERVER names the launch surface; the desktop only bounds it to
      // the control host's own domain. Forcing a desktop-chosen path here
      // is what broke every managed activation when /business-os/ retired.
      assert.equal(url.origin, "https://skf.ctox.dev");
      assert.equal(url.pathname, "/legacy");
      assert.equal(launch.launchOrigin, "https://skf.ctox.dev");
      assert.deepEqual(config.desktop_instance, {
        id: descriptor.id,
        source: "ctox_dev",
        display_name: descriptor.displayName,
        domain: descriptor.domain,
      });
      assert.deepEqual(config.desktop_managed_auth, { required: true });
      assert.equal(config.transport, "webrtc");
      assert.equal(config.http_bridge_available, false);
      assert.deepEqual(calls, [
        {
          url: "https://ctox.dev/api/desktop/launch-token",
          init: {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: {
              "content-type": "application/json",
              "x-ctox-desktop-client": "ctox-business-os-desktop",
            },
            body: encodeUnknownJson({ tenantId: "tenant_skf" }),
          },
        },
        {
          url: "https://ctox.dev/api/desktop/launch/token_1",
          init: {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "x-ctox-desktop-client": "ctox-business-os-desktop" },
          },
        },
      ]);
    }).pipe(Effect.provide(harness(fetchImpl)));
  });

  it.effect("resolves only the server-bound canonical authority id for WELSCH", () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/desktop/launch-token")) {
        return response({ launchConfigUrl: "https://ctox.dev/api/desktop/launch/welsch" });
      }
      return response({
        launchUrl: "https://skf.ctox.dev/",
        pairingConfig: {
          transport: "webrtc",
          http_bridge_available: false,
          instance_id: "business-os-welsch",
          sync_room: "never-return-this-room",
          signaling_browser_token: "never-return-this-secret",
        },
      });
    });

    return Effect.gen(function* () {
      const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
      assert.equal(yield* launches.resolveBusinessOsInstanceId(descriptor), "business-os-welsch");
    }).pipe(Effect.provide(harness(fetchImpl)));
  });

  it.effect("fails closed when managed authority identity is missing or ambiguous", () => {
    const configs = [
      { transport: "webrtc", http_bridge_available: false },
      {
        transport: "webrtc",
        http_bridge_available: false,
        instance_id: "business-os-a",
        instanceId: "business-os-b",
      },
    ];
    let index = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/desktop/launch-token")) {
        return response({ launchConfigUrl: `https://ctox.dev/api/desktop/launch/${index}` });
      }
      return response({ launchUrl: "https://tenant.ctox.dev/", pairingConfig: configs[index++] });
    });

    return Effect.gen(function* () {
      const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
      for (const _config of configs) {
        const error = yield* launches.resolveBusinessOsInstanceId(descriptor).pipe(Effect.flip);
        assert.equal(error.operation, "launch-contract");
      }
    }).pipe(Effect.provide(harness(fetchImpl)));
  });

  it.effect("requests a fresh launch exchange on every activation", () => {
    let epoch = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/desktop/launch-token")) {
        epoch += 1;
        return response({ launchConfigUrl: `https://ctox.dev/api/desktop/launch/token_${epoch}` });
      }
      return response({
        launchUrl: "https://tenant.ctox.dev/",
        pairingConfig: { transport: "webrtc", http_bridge_available: false, epoch },
      });
    });

    return Effect.gen(function* () {
      const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
      const first = yield* launches.launch(descriptor);
      const second = yield* launches.launch(descriptor);
      assert.equal(decodeConfig(first.launchUrl).epoch, 1);
      assert.equal(decodeConfig(second.launchUrl).epoch, 2);
      assert.strictEqual(fetchImpl.mock.calls.length, 4);
    }).pipe(Effect.provide(harness(fetchImpl)));
  });

  it.effect(
    "pins the credential-bearing launch config POST to the exact control-plane origin",
    () => {
      const secret = "must-not-leak";
      const fetchImpl = vi.fn(async () =>
        response({ launchConfigUrl: `https://evil.example/api/desktop/launch/${secret}` }),
      );

      return Effect.gen(function* () {
        const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
        const error = yield* launches.launch(descriptor).pipe(Effect.flip);
        assert.equal(error.message, "The managed CTOX launch exchange failed.");
        assert.notInclude(error.message, secret);
        assert.strictEqual(fetchImpl.mock.calls.length, 1);
      }).pipe(Effect.provide(harness(fetchImpl)));
    },
  );

  it.effect("rejects non-WebRTC and HTTP-bridge launch configurations", () => {
    const configs = [
      { transport: "http", http_bridge_available: false },
      { transport: "webrtc", http_bridge_available: true },
    ];
    let index = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/desktop/launch-token")) {
        return response({ launchConfigUrl: `https://ctox.dev/api/desktop/launch/token_${index}` });
      }
      return response({ launchUrl: "https://tenant.ctox.dev/", pairingConfig: configs[index++] });
    });

    return Effect.gen(function* () {
      const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
      for (const _config of configs) {
        const error = yield* launches.launch(descriptor).pipe(Effect.flip);
        assert.equal(error.operation, "launch-contract");
      }
    }).pipe(Effect.provide(harness(fetchImpl)));
  });

  it.effect("uses the server-packed WebRTC config when public pairing metadata is redacted", () => {
    const packedConfig = {
      transport: "webrtc",
      http_bridge_available: false,
      sync_room: "real-room",
      signaling_auth_version: "ctox-role-bound-v1",
      signaling_browser_token: "real-browser-token",
      signaling_browser_token_hash:
        "bd37e588e3f74500fa9ccb2f89c95a4b3daefc17af3c359173193b57c1e10b83",
      signaling_native_token_hash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const packed = Buffer.from(encodeUnknownJson(packedConfig), "utf8").toString("base64url");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/desktop/launch-token")) {
        return response({ launchConfigUrl: "https://ctox.dev/api/desktop/launch/token_1" });
      }
      return response({
        launchUrl: `https://tenant.ctox.dev/?ctox_config=${packed}`,
        pairingConfig: {
          transport: "webrtc",
          http_bridge_available: false,
          sync_room: "<redacted>",
          signaling_browser_token: "<redacted>",
        },
      });
    });

    return Effect.gen(function* () {
      const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
      const launch = yield* launches.launch(descriptor);
      const config = decodeConfig(launch.launchUrl);
      assert.equal(config.sync_room, "real-room");
      assert.equal(config.signaling_browser_token, "real-browser-token");
      assert.notInclude(launch.launchUrl, "<redacted>");
    }).pipe(Effect.provide(harness(fetchImpl)));
  });

  it.effect("refuses a launch URL outside the control plane's own domain", () => {
    // Following the server's URL is only safe while it stays on the control
    // host or a subdomain of it. A compromised or misconfigured response
    // naming a foreign host must fail the launch, not open it.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/desktop/launch-token")) {
        return response({ launchConfigUrl: "https://ctox.dev/api/desktop/launch/token_1" });
      }
      return response({
        launchUrl: "https://ctox.dev.attacker.example/business-os/",
        pairingConfig: {
          transport: "webrtc",
          http_bridge_available: false,
          sync_room: "ctox-business-os:skf",
        },
      });
    });

    return Effect.gen(function* () {
      const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
      const result = yield* launches.launch(descriptor).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(harness(fetchImpl)));
  });
});
