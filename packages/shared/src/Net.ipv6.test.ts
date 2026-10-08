import * as NodeNet from "node:net";
import { describe, expect, it, vi } from "vite-plus/test";
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
  it("retains a free IPv4 port when the kernel rejects the IPv6 family", async () => {
    const net = NetService.make();
    const port = await Effect.runPromise(net.reserveLoopbackPort());
    expect(port).toBeGreaterThan(0);
    expect(await Effect.runPromise(net.isPortAvailableOnLoopback(port))).toBe(true);
    expect(await Effect.runPromise(net.findAvailablePort(port))).toBe(port);
  });
  it("still rejects an occupied IPv4 port", async () => {
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing bound test port");
      expect(
        await Effect.runPromise(NetService.make().isPortAvailableOnLoopback(address.port)),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
