// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect } from "vite-plus/test";
import * as Account from "./CtoxAccountLifecycle.ts";
import { createCtoxDeviceProofKey } from "./CtoxDeviceProofKey.ts";
import {
  createCtoxNativeCredentialLease,
  bindCtoxNativeCredentialCallback,
} from "./CtoxNativeSessionCredentials.ts";

const nonce = "a".repeat(43);
const fixture = Effect.gen(function* () {
  const account = yield* Account.make;
  const key = createCtoxDeviceProofKey();
  let reads = 0;
  let current = true;
  let time = 100;
  const lease = createCtoxNativeCredentialLease({
    account,
    sessionEpoch: account.sessionEpoch(),
    registry: {
      deviceProofKey: () =>
        Effect.sync(() => {
          reads++;
          return key;
        }),
    },
    scope: { instanceId: "instance", userId: "user" },
    capabilityToken: Redacted.make("test-capability"),
    expiresAtMs: 200,
    createKeyIfMissing: false,
    targetIsCurrent: () => current,
    now: () => time,
  });
  return {
    account,
    key,
    lease,
    reads: () => reads,
    retire: () => {
      current = false;
    },
    expire: () => {
      time = 200;
    },
  };
});

describe("native credential lifetime", () => {
  it.effect("does not expose a token retired between key completion and IPC reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const guarded = {
        ...f.lease,
        provide: (challenge: string | undefined) =>
          f.lease.provide(challenge).then((credentials) => {
            f.retire();
            return credentials;
          }),
      };
      const reply = bindCtoxNativeCredentialCallback(guarded, {
        targetId: "saved-target",
        connectionId: "connection",
        sessionEpoch: f.account.sessionEpoch(),
      });
      yield* Effect.promise(async () => {
        try {
          await expect(
            reply({
              version: 1,
              requestId: "request",
              targetId: "saved-target",
              connectionId: "connection",
              sessionEpoch: f.account.sessionEpoch(),
              nonce,
            }),
          ).rejects.toThrow("no longer available");
          expect(f.reads()).toBe(1);
        } finally {
          await f.lease.close();
        }
      });
    }),
  );

  it.effect("rejects a binding whose epoch differs from its credential lease", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reply = bindCtoxNativeCredentialCallback(f.lease, {
        targetId: "saved-target",
        connectionId: "connection",
        sessionEpoch: 99,
      });
      yield* Effect.promise(async () => {
        try {
          await expect(
            reply({
              version: 1,
              requestId: "request",
              targetId: "saved-target",
              connectionId: "connection",
              sessionEpoch: 99,
              nonce,
            }),
          ).rejects.toThrow("no longer available");
          expect(f.reads()).toBe(0);
        } finally {
          await f.lease.close();
        }
      });
    }),
  );

  it.effect("binds private IPC challenges to the captured target, connection and epoch", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reply = bindCtoxNativeCredentialCallback(f.lease, {
        targetId: "saved-target",
        connectionId: "connection",
        sessionEpoch: f.account.sessionEpoch(),
      });
      const request = {
        version: 1,
        requestId: "request",
        targetId: "saved-target",
        connectionId: "connection",
        sessionEpoch: f.account.sessionEpoch(),
        nonce,
      };
      yield* Effect.promise(async () => {
        try {
          for (const changed of [
            { targetId: "other" },
            { connectionId: "other" },
            { sessionEpoch: 99 },
            { version: 2 },
            { extra: "ignored?" },
          ]) {
            await expect(reply({ ...request, ...changed })).rejects.toThrow("no longer available");
          }
          expect(f.reads()).toBe(0);
          const answer = await reply(request);
          expect(answer.requestId).toBe("request");
          expect(answer.connectionId).toBe("connection");
          expect(answer.capabilityToken).toBe("test-capability");
          expect(answer.deviceProof?.publicX).toBe(f.key.publicJwk.x);
        } finally {
          await f.lease.close();
        }
      });
    }),
  );

  it.effect("allows initial credentials after proof without confirming the account", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(async () => {
        try {
          const preflight = await f.lease.provide(undefined);
          expect(preflight.deviceProof).toBeUndefined();
          expect(f.reads()).toBe(0);
          const proof = await f.lease.provide(nonce);
          expect(proof.deviceProof?.publicX).toBe(f.key.publicJwk.x);
          expect(f.account.isCurrent(f.account.sessionEpoch())).toBe(false);
        } finally {
          await f.lease.close();
        }
      });
    }),
  );

  it.effect("rejects retired targets, expiry and malformed challenges before key access", () =>
    Effect.gen(function* () {
      for (const reason of ["target", "expiry", "nonce"]) {
        const f = yield* fixture;
        yield* Effect.promise(async () => {
          try {
            if (reason === "target") f.retire();
            if (reason === "expiry") f.expire();
            await expect(
              f.lease.provide(reason === "nonce" ? nonce + "\n" : nonce),
            ).rejects.toThrow("no longer available");
            expect(f.reads()).toBe(0);
          } finally {
            await f.lease.close();
          }
        });
      }
    }),
  );

  it.effect("cancels pending key access and fences callbacks on account transition", () =>
    Effect.gen(function* () {
      const account = yield* Account.make;
      const entered = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<ReturnType<typeof createCtoxDeviceProofKey>>();
      const lease = createCtoxNativeCredentialLease({
        account,
        sessionEpoch: account.sessionEpoch(),
        registry: {
          deviceProofKey: () =>
            Effect.promise(() => {
              entered.resolve();
              return blocked.promise;
            }),
        },
        scope: { instanceId: "instance", userId: "user" },
        capabilityToken: Redacted.make("test-capability"),
        expiresAtMs: 200,
        createKeyIfMissing: false,
        targetIsCurrent: () => true,
        now: () => 100,
      });
      const rejected = expect(lease.provide(nonce)).rejects.toThrow("no longer available");
      yield* Effect.promise(() => entered.promise);
      yield* account.transition("logout", Effect.void);
      yield* Effect.promise(async () => {
        await rejected;
        blocked.resolve(createCtoxDeviceProofKey());
        await expect(lease.provide(nonce)).rejects.toThrow("no longer available");
        await lease.close();
      });
    }),
  );

  it.effect("rejects a mismatched enrolled key and never authorizes replacement", () =>
    Effect.gen(function* () {
      const account = yield* Account.make;
      let create: boolean | undefined;
      const lease = createCtoxNativeCredentialLease({
        account,
        sessionEpoch: account.sessionEpoch(),
        registry: {
          deviceProofKey: (_, allowed) =>
            Effect.sync(() => {
              create = allowed;
              return createCtoxDeviceProofKey();
            }),
        },
        scope: { instanceId: "instance", userId: "user" },
        capabilityToken: Redacted.make("test-capability"),
        expiresAtMs: 200,
        expectedThumbprint: "different-enrolled-key",
        createKeyIfMissing: true,
        targetIsCurrent: () => true,
        now: () => 100,
      });
      yield* Effect.promise(async () => {
        try {
          await expect(lease.provide(nonce)).rejects.toThrow("no longer available");
          expect(create).toBe(false);
        } finally {
          await lease.close();
        }
      });
    }),
  );
});
