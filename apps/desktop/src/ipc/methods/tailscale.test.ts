import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { NodeServices } from "@effect/platform-node";

const status = vi.hoisted(() => ({ failed: false }));
vi.mock("@workjet/tailscale", async () => {
  const Effect = await import("effect/Effect");
  return {
    readTailscalePeers: Effect.suspend(() =>
      status.failed
        ? Effect.fail(new Error("tskey-private CLI output"))
        : Effect.succeed({
            status: "available",
            peers: [{ id: "gpu", name: "gpu1", hostname: "100.64.1.1", online: true }],
          }),
    ),
  };
});
import { discoverTailscalePeers } from "./tailscale.ts";

describe("desktop Tailscale discovery IPC", () => {
  it.effect("returns the typed live peer result", () =>
    Effect.gen(function* () {
      status.failed = false;
      const result = yield* discoverTailscalePeers.handler(undefined);
      expect(result).toEqual({
        status: "available",
        peers: [{ id: "gpu", name: "gpu1", hostname: "100.64.1.1", online: true }],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("returns unavailable without CLI diagnostics or cached peers after failure", () =>
    Effect.gen(function* () {
      status.failed = true;
      const result = yield* discoverTailscalePeers.handler(undefined);
      expect(result).toEqual({ status: "unavailable", peers: [] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
