import * as NodeNet from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as NetService from "./Net.ts";

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeNet>();
  return {
    ...actual,
    createServer: () => {
      const server = actual.createServer();
      const listen = server.listen.bind(server);
      server.listen = ((...args: Parameters<typeof server.listen>) => {
        const options = args[0];
        if (
          typeof options === "object" &&
          options !== null &&
          "host" in options &&
          options.host === "::1"
        ) {
          queueMicrotask(() =>
            server.emit(
              "error",
              Object.assign(new Error("IPv6 disabled"), { code: "EAFNOSUPPORT" }),
            ),
          );
          return server;
        }
        return Reflect.apply(listen, server, args);
      }) as typeof server.listen;
      return server;
    },
  };
});

describe("loopback ports without IPv6 support", () => {
  it.effect("retains a free IPv4 port when the kernel rejects the IPv6 family", () =>
    Effect.gen(function* () {
      const net = NetService.make();
      const port = yield* net.reserveLoopbackPort();
      expect(port).toBeGreaterThan(0);
      expect(yield* net.isPortAvailableOnLoopback(port)).toBe(true);
      expect(yield* net.findAvailablePort(port)).toBe(port);
    }),
  );
  it.effect("still rejects an occupied IPv4 port", () =>
    Effect.gen(function* () {
      const server = NodeNet.createServer();
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing bound test port");
        expect(yield* NetService.make().isPortAvailableOnLoopback(address.port)).toBe(false);
      } finally {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
      }
    }),
  );
});
