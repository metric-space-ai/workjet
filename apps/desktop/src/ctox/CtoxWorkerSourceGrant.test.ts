// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { CtoxDecisionHubProvisionInput } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  acquireWorkjetWorkerSourceGrant,
  issueWorkjetWorkerSourceGrant,
  revokeWorkjetWorkerSourceGrant,
  WORKER_SOURCE_RENEW_AFTER_MS,
  workerSourceGrantIdentity,
  workerSourceNeedsRenewal,
} from "./CtoxWorkerSourceGrant.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const tenant = "11111111-2222-3333-4444-555555555555";
const tokenId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const token = "synthetic-one-time-worker-token";
const payload = {
  ok: true,
  token: { token, tokenId },
  managedMcp: { mcpUrl: "https://mcp.ctox.dev/mcp/native-source.ctox.dev" },
};
const reply = (body: unknown = payload) => Response.json(body);

describe("additional Workjet worker source client", () => {
  it("requests only worker dispatch and Luma configuration tools with a one-day grant", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply());
    const result = await issueWorkjetWorkerSourceGrant(fetch, tenant);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://ctox.dev/api/instances/${tenant}/managed-mcp`);
    expect(init!.credentials).toBe("include");
    expect(decodeJson(init!.body as string)).toEqual({
      action: "rotate_token",
      label: "Workjet worker source",
      expiresInDays: 1,
      scopes: {
        allowReads: true,
        allowWrites: true,
        allowApprovals: false,
        allowExternalEffects: false,
        rateLimitPerMinute: 30,
        allowedModules: ["ctox"],
        allowedCollections: ["workjet_luma_configuration"],
        allowedTools: [
          "business_os.remote_worker_admission",
          "business_os.workjet_worker_dispatch",
          "business_os.luma_configuration_read",
          "business_os.luma_configuration_update",
        ],
        deniedTools: [],
      },
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
  ])(
    "rolls back only the newly issued client when endpoint validation fails (%s)",
    async (mcpUrl) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(reply({ ...payload, managedMcp: { mcpUrl } }))
        .mockResolvedValueOnce(reply({ ok: true, revoked: true }));
      await expect(issueWorkjetWorkerSourceGrant(fetch, tenant)).rejects.toThrow(
        "grant_unavailable",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(decodeJson(fetch.mock.calls[1]![1].body)).toEqual({ action: "revoke_token", tokenId });
    },
  );

  it("does not leak response content or attempt revocation without a new client identity", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response("<html>one-time-secret</html>", { status: 200 }),
    );
    await expect(issueWorkjetWorkerSourceGrant(fetch, tenant)).rejects.toThrow(
      /^grant_unavailable$/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports sign-in failure without issuing or changing another client", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("", { status: 401 }),
    );
    await expect(issueWorkjetWorkerSourceGrant(fetch, tenant)).rejects.toThrow(/^signed_out$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reconstructs only this product's additional grant identity after restart", async () => {
    const id = `ctox-dev-worker-source:${tenant}:${tokenId}`;
    expect(workerSourceGrantIdentity(id)).toEqual({ tenantId: tenant, tokenId });
    expect(workerSourceGrantIdentity(`ctox-dev:${tenant}`)).toBeUndefined();
    expect(workerSourceGrantIdentity(id + ":foreign")).toBeUndefined();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      reply({ ok: true, revoked: true }),
    );
    await revokeWorkjetWorkerSourceGrant(fetch, workerSourceGrantIdentity(id)!);
    expect(decodeJson(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      action: "revoke_token",
      tokenId,
    });
  });

  it("keeps legacy provisioning valid and validates the explicit worker purpose", () => {
    const decode = Schema.decodeUnknownSync(CtoxDecisionHubProvisionInput);
    const input = {
      environmentId: "source-environment",
      target: { _tag: "ctox_dev", tenantId: tenant },
    };
    expect(decode(input).purpose).toBeUndefined();
    expect(decode({ ...input, purpose: "worker_source" }).purpose).toBe("worker_source");
    expect(() => decode({ ...input, purpose: "all_tools" })).toThrow();
  });
});

describe("worker source credential custody", () => {
  it.effect("revokes the newly issued client if the environment RPC fails", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(reply())
        .mockResolvedValueOnce(reply({ ok: true, revoked: true }));
      const rolledBack = vi.fn();
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireWorkjetWorkerSourceGrant(fetch, tenant, () => Effect.sync(rolledBack));
          return yield* Effect.fail("environment RPC rejected");
        }),
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      expect(rolledBack).toHaveBeenCalledOnce();
      expect(decodeJson(fetch.mock.calls[1]![1].body)).toEqual({ action: "revoke_token", tokenId });
    }),
  );

  it.effect("retains the client only after the environment confirms custody", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply());
      yield* Effect.scoped(
        Effect.gen(function* () {
          const grant = yield* acquireWorkjetWorkerSourceGrant(fetch, tenant);
          grant.commit();
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("revokes on interruption before the environment confirmation", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(reply())
        .mockResolvedValueOnce(reply({ ok: true, revoked: true }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                yield* acquireWorkjetWorkerSourceGrant(fetch, tenant);
                yield* Deferred.succeed(acquired, undefined);
                return yield* Effect.never;
              }),
            ),
          );
          yield* Deferred.await(acquired);
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(decodeJson(fetch.mock.calls[1]![1].body)).toEqual({ action: "revoke_token", tokenId });
    }),
  );
});

describe("worker source silent renewal", () => {
  const connectionId = `ctox-dev-worker-source:${tenant}:${tokenId}`;
  const now = 1_000_000_000_000;
  const ready = { connectionId, source: "ctox_dev", status: "ready" };

  it("renews connections that need sign-in, regardless of age", () => {
    expect(workerSourceNeedsRenewal({ ...ready, status: "needs_auth" }, now, now)).toBe(true);
  });

  it("renews ready grants after 20 hours and ones issued before this app start", () => {
    expect(workerSourceNeedsRenewal(ready, now - 1_000, now)).toBe(false);
    expect(workerSourceNeedsRenewal(ready, now - WORKER_SOURCE_RENEW_AFTER_MS, now)).toBe(true);
    expect(workerSourceNeedsRenewal(ready, undefined, now)).toBe(true);
  });

  it("leaves other connections and states alone", () => {
    expect(
      workerSourceNeedsRenewal({ ...ready, connectionId: `ctox-dev:${tenant}` }, undefined, now),
    ).toBe(false);
    expect(workerSourceNeedsRenewal({ ...ready, source: "local_ctox" }, undefined, now)).toBe(false);
    expect(workerSourceNeedsRenewal({ ...ready, status: "unsupported" }, undefined, now)).toBe(
      false,
    );
  });
});
