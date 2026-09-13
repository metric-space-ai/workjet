import { describe, expect, it, vi } from "vite-plus/test";
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
  it("returns the typed live peer result", async () => {
    status.failed = false;
    expect(
      await Effect.runPromise(
        discoverTailscalePeers.handler(undefined).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).toEqual({
      status: "available",
      peers: [{ id: "gpu", name: "gpu1", hostname: "100.64.1.1", online: true }],
    });
  });
  it("returns unavailable without CLI diagnostics or cached peers after failure", async () => {
    status.failed = true;
    expect(
      await Effect.runPromise(
        discoverTailscalePeers.handler(undefined).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).toEqual({ status: "unavailable", peers: [] });
  });
});
