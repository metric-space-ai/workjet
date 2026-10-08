// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { CtoxDecisionHubProvisionInput } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  acquireWorkjetWorkerSourceGrant, issueWorkjetWorkerSourceGrant, revokeWorkjetWorkerSourceGrant,
  workerSourceGrantIdentity, WORKJET_WORKER_SOURCE_TOOLS,
} from "./CtoxWorkerSourceGrant.ts";

const tenant = "11111111-2222-3333-4444-555555555555";
const tokenId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const token = "synthetic-one-time-worker-token";
const payload = {
  ok: true, token: { token, tokenId },
  managedMcp: { mcpUrl: "https://mcp.ctox.dev/mcp/native-source.ctox.dev" },
};
const reply = (body: unknown = payload) => Response.json(body);

describe("additional Workjet worker source client", () => {
  it("uses the authenticated owner API with exactly two write tools and a one-day grant", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply());
    const result = await issueWorkjetWorkerSourceGrant(fetch, tenant);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://ctox.dev/api/instances/${tenant}/managed-mcp`);
    expect(init!.credentials).toBe("include");
    expect(JSON.parse(init!.body as string)).toEqual({
      action: "rotate_token", label: "Workjet worker source", expiresInDays: 1,
      scopes: { allowReads: false, allowWrites: true, allowApprovals: false,
        allowExternalEffects: false, rateLimitPerMinute: 30, allowedModules: ["ctox"],
        allowedCollections: ["__ctox_no_access__"], allowedTools: [...WORKJET_WORKER_SOURCE_TOOLS],
        deniedTools: [] },
    });
    expect(result.instanceId).toBe("native-source.ctox.dev");
    expect(result.instanceId).not.toBe(tenant);
    expect(result.connectionId).toBe(`ctox-dev-worker-source:${tenant}:${tokenId}`);
    expect(result.connectionId).not.toBe(`ctox-dev:${tenant}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://foreign.example/mcp/native-source.ctox.dev",
    "https://mcp.ctox.dev/mcp/managed%3Aworkspace",
    "https://mcp.ctox.dev/mcp/native?token=secret",
  ])("rolls back only the newly issued client when endpoint validation fails (%s)", async (mcpUrl) => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ ...payload, managedMcp: { mcpUrl } }))
      .mockResolvedValueOnce(reply({ ok: true, revoked: true }));
    await expect(issueWorkjetWorkerSourceGrant(fetch, tenant)).rejects.toThrow("grant_unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ action: "revoke_token", tokenId });
  });

  it("does not leak response content or attempt revocation without a new client identity", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("<html>one-time-secret</html>", { status: 200 }));
    await expect(issueWorkjetWorkerSourceGrant(fetch, tenant)).rejects.toThrow(/^grant_unavailable$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports sign-in failure without issuing or changing another client", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 401 }));
    await expect(issueWorkjetWorkerSourceGrant(fetch, tenant)).rejects.toThrow(/^signed_out$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reconstructs only this product's additional grant identity after restart", async () => {
    const id = `ctox-dev-worker-source:${tenant}:${tokenId}`;
    expect(workerSourceGrantIdentity(id)).toEqual({ tenantId: tenant, tokenId });
    expect(workerSourceGrantIdentity(`ctox-dev:${tenant}`)).toBeUndefined();
    expect(workerSourceGrantIdentity(id + ":foreign")).toBeUndefined();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply({ ok: true, revoked: true }));
    await revokeWorkjetWorkerSourceGrant(fetch, workerSourceGrantIdentity(id)!);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ action: "revoke_token", tokenId });
  });

  it("keeps legacy provisioning valid and validates the explicit worker purpose", () => {
    const decode = Schema.decodeUnknownSync(CtoxDecisionHubProvisionInput);
    const input = { environmentId: "source-environment", target: { _tag: "ctox_dev", tenantId: tenant } };
    expect(decode(input).purpose).toBeUndefined();
    expect(decode({ ...input, purpose: "worker_source" }).purpose).toBe("worker_source");
    expect(() => decode({ ...input, purpose: "all_tools" })).toThrow();
  });
});

describe("worker source credential custody", () => {
  it("revokes the newly issued client if the environment RPC fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(reply({ ok: true, revoked: true }));
    const rolledBack = vi.fn();
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* acquireWorkjetWorkerSourceGrant(fetch, tenant, () => Effect.sync(rolledBack));
      return yield* Effect.fail("environment RPC rejected");
    })).pipe(Effect.exit));
    expect(exit._tag).toBe("Failure");
    expect(rolledBack).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ action: "revoke_token", tokenId });
  });

  it("retains the client only after the environment confirms custody", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply());
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const grant = yield* acquireWorkjetWorkerSourceGrant(fetch, tenant);
      grant.commit();
    })));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("revokes on interruption before the environment confirmation", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(reply({ ok: true, revoked: true }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
        yield* acquireWorkjetWorkerSourceGrant(fetch, tenant);
        yield* Deferred.succeed(acquired, undefined);
        yield* Effect.never;
      })));
      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(fiber);
    })));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ action: "revoke_token", tokenId });
  });
});
