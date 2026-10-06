import type { DesktopBridge } from "@workjet/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError } from "effect/unstable/http";

import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";
import { makePrimaryEnvironmentHttpLayer } from "./httpLayer";

describe.sequential("primary environment HTTP layer", () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("uses cookie credentials for browser primary environments", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:3773/settings",
          origin: "http://127.0.0.1:3773",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/auth/session");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect("uses bearer auth without cookies for desktop-managed primaries", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "workjet://app" },
        desktopBridge: {
          getLocalEnvironmentBootstrap: () => ({
            label: "Local environment",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          }),
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/connect/link-state");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });
  it.effect("fails before sending and obtains a recovered credential on the next request", () => {
    const unavailable = new Error("Local service session is not ready");
    const getToken = vi
      .fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValue("recovered-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "workjet://app" },
        desktopBridge: { getLocalEnvironmentBearerToken: getToken } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(HttpClient.get("http://127.0.0.1:3773/api/auth/session"));
      expect(error).toBeInstanceOf(HttpClientError.HttpClientError);
      expect(error.reason).toBeInstanceOf(HttpClientError.TransportError);
      expect(error.cause).toBe(unavailable);
      expect(fetchMock).not.toHaveBeenCalled();

      yield* HttpClient.get("http://127.0.0.1:3773/api/auth/session");
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.headers.get("authorization")).toBe("Bearer recovered-token");
      expect(request.credentials).toBe("omit");
    }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
  });

  it.effect(
    "does not send requests or use bootstrap credentials when protected access is denied",
    () => {
      const denied = new Error("Protected credential access denied");
      const getToken = vi.fn().mockRejectedValue(denied);
      const getBootstrap = vi
        .fn()
        .mockReturnValue({ bootstrapToken: "bootstrap-must-not-be-used" });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          location: { origin: "workjet://app" },
          desktopBridge: {
            getLocalEnvironmentBearerToken: getToken,
            getLocalEnvironmentBootstrap: getBootstrap,
          } as unknown as DesktopBridge,
        },
      });

      return Effect.gen(function* () {
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = yield* Effect.flip(
            HttpClient.get("http://127.0.0.1:3773/api/auth/session"),
          );
          expect(error).toBeInstanceOf(HttpClientError.HttpClientError);
          expect(error.cause).toBe(denied);
        }
        expect(getToken).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getBootstrap).not.toHaveBeenCalled();
      }).pipe(Effect.provide(makePrimaryEnvironmentHttpLayer()));
    },
  );
});
