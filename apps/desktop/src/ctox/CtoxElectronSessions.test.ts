// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxManagedInstance } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";

const { fromPartition, fakeSessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  fakeSessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("electron", () => ({ session: { fromPartition } }));

import { ctoxManagedSessionPartition } from "./CtoxManagedDiscovery.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";

function descriptor(id = "managed:tenant-a"): CtoxManagedInstance {
  return {
    id,
    source: "ctox_dev",
    displayName: "Tenant A",
    status: "available",
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: true,
      httpDataProxy: false,
      nativePeerObserved: true,
    },
  };
}

function pairedDescriptor(
  source: "pairing_invite" | "manual_pairing" = "manual_pairing",
): CtoxManagedInstance {
  return {
    id: `paired:${source}:abcdefghijklmnopqrstuv`,
    source,
    displayName: "Paired Office",
    status: "paired",
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: false,
      httpDataProxy: false,
      nativePeerObserved: false,
    },
  };
}

function partitionOf(instanceDescriptor: CtoxManagedInstance): string {
  return ctoxManagedSessionPartition({
    source: instanceDescriptor.source,
    id: instanceDescriptor.id,
  });
}

function requestDecision(sessionPartition: string, permission: string): boolean {
  const fakeSession = fakeSessions.get(sessionPartition);
  assert.isDefined(fakeSession);
  const handler = fakeSession.setPermissionRequestHandler.mock.calls[0]?.[0];
  assert.isFunction(handler);
  let decision: boolean | undefined;
  handler(null, permission, (allowed: boolean) => {
    decision = allowed;
  });
  assert.isDefined(decision);
  return decision;
}

function checkDecision(sessionPartition: string, permission: string): boolean {
  const fakeSession = fakeSessions.get(sessionPartition);
  assert.isDefined(fakeSession);
  const handler = fakeSession.setPermissionCheckHandler.mock.calls[0]?.[0];
  assert.isFunction(handler);
  return handler(null, permission) as boolean;
}

describe("CtoxElectronSessions", () => {
  beforeEach(() => {
    fakeSessions.clear();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const fakeSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      };
      fakeSessions.set(partition, fakeSession);
      return fakeSession;
    });
  });

  it.effect(
    "owns isolated deterministic account and instance sessions and memoizes each partition",
    () =>
      Effect.gen(function* () {
        const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
        const instanceDescriptor = descriptor();

        const firstAccount = yield* sessions.account;
        const secondAccount = yield* sessions.account;
        const firstInstance = yield* sessions.instance(instanceDescriptor);
        const secondInstance = yield* sessions.instance(instanceDescriptor);

        assert.strictEqual(firstAccount, secondAccount);
        assert.strictEqual(firstInstance, secondInstance);
        assert.notStrictEqual(firstAccount, firstInstance);
        assert.deepEqual(fromPartition.mock.calls, [
          [CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION],
          [partitionOf(instanceDescriptor)],
        ]);
        assert.notEqual(
          CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION,
          partitionOf(instanceDescriptor),
        );
      }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );

  it.effect("uses deterministic source-isolated partitions for managed and paired instances", () =>
    Effect.gen(function* () {
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      const managed = descriptor();
      const invited = pairedDescriptor("pairing_invite");
      const manual = pairedDescriptor("manual_pairing");

      yield* sessions.instance(managed);
      yield* sessions.instance(invited);
      yield* sessions.instance(manual);

      assert.deepEqual(fromPartition.mock.calls, [
        [partitionOf(managed)],
        [partitionOf(invited)],
        [partitionOf(manual)],
      ]);
      assert.notEqual(partitionOf(invited), partitionOf(manual));
    }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );

  it.effect("gives a launchable SSH-managed instance its own isolated partition", () =>
    Effect.gen(function* () {
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      // Launching one means driving a guest at forwarded loopback signaling
      // ports; that guest may not share storage with any other instance.
      const sshManaged: CtoxManagedInstance = {
        id: "ssh:AAAAAAAAAAAAAAAAAAAAAA",
        source: "ssh_managed" as const,
        displayName: "Build Box",
        status: "available" as const,
        healthSummary: {
          dataPlane: "rxdb-webrtc" as const,
          dataPlaneReady: false,
          httpDataProxy: false,
          nativePeerObserved: false,
        },
      };

      const first = yield* sessions.instance(sshManaged);
      const second = yield* sessions.instance(sshManaged);

      assert.strictEqual(first, second);
      assert.deepEqual(fromPartition.mock.calls, [[partitionOf(sshManaged)]]);
      assert.notEqual(partitionOf(sshManaged), CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION);
    }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );

  it.effect("rejects mismatched paired, local, SSH, and arbitrary descriptors", () =>
    Effect.gen(function* () {
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      const invalid = [
        {
          ...pairedDescriptor("manual_pairing"),
          source: "pairing_invite" as const,
        },
        { ...descriptor(), id: "forged-instance", source: "local_daemon" as const },
        { ...descriptor(), id: "ssh:tenant-a", source: "ssh_managed" as const },
        {
          id: "ssh:AAAAAAAAAAAAAAAAAAAAAA",
          source: "ssh_managed",
          displayName: "Build Box",
          // Offline: the daemon is not answering, so nothing may be launched.
          status: "offline",
          healthSummary: {
            dataPlane: "rxdb-webrtc",
            dataPlaneReady: false,
            httpDataProxy: false,
            nativePeerObserved: false,
          },
        } satisfies CtoxManagedInstance,
        { ...pairedDescriptor(), status: "pairing_expired" as const },
      ];
      for (const candidate of invalid) {
        const error = yield* sessions.instance(candidate).pipe(Effect.flip);
        assert.instanceOf(error, CtoxElectronSessions.CtoxElectronSessionDescriptorError);
        assert.equal(error.message, "The CTOX instance session descriptor is invalid.");
        assert.notInclude(error.message, candidate.id);
      }
      expect(fromPartition).not.toHaveBeenCalled();
    }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );

  it.effect("rejects non-managed descriptors before Electron resolution", () =>
    Effect.gen(function* () {
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      const arbitrary = { ...descriptor(), id: "forged-instance", source: "local_daemon" as const };
      const error = yield* sessions.instance(arbitrary).pipe(Effect.flip);

      assert.instanceOf(error, CtoxElectronSessions.CtoxElectronSessionDescriptorError);
      assert.equal(error.message, "The CTOX instance session descriptor is invalid.");
      expect(fromPartition).not.toHaveBeenCalled();
      assert.notInclude(error.message, arbitrary.id);
    }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );

  it.effect("denies account permissions and grants only exact instance permissions", () =>
    Effect.gen(function* () {
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      const instanceDescriptor = descriptor();
      yield* sessions.account;
      yield* sessions.instance(instanceDescriptor);

      for (const permission of [
        "notifications",
        "clipboard-sanitized-write",
        "clipboard-read",
        "geolocation",
        "midi",
      ]) {
        assert.isFalse(
          requestDecision(CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION, permission),
        );
        assert.isFalse(
          checkDecision(CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION, permission),
        );
      }

      for (const permission of ["notifications", "clipboard-sanitized-write"]) {
        assert.isTrue(requestDecision(partitionOf(instanceDescriptor), permission));
        assert.isTrue(checkDecision(partitionOf(instanceDescriptor), permission));
      }
      for (const permission of ["clipboard-read", "clipboard-write", "geolocation", "midi"]) {
        assert.isFalse(requestDecision(partitionOf(instanceDescriptor), permission));
        assert.isFalse(checkDecision(partitionOf(instanceDescriptor), permission));
      }
    }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );

  it.effect("clears storage and cache only in the selected instance partition", () =>
    Effect.gen(function* () {
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      const first = descriptor("managed:tenant-a");
      const second = descriptor("managed:tenant-b");
      yield* sessions.account;
      yield* sessions.instance(second);
      yield* sessions.clearInstance(first);

      const firstSession = fakeSessions.get(partitionOf(first));
      const secondSession = fakeSessions.get(partitionOf(second));
      const accountSession = fakeSessions.get(CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION);
      assert.isDefined(firstSession);
      assert.isDefined(secondSession);
      assert.isDefined(accountSession);
      assert.deepEqual(firstSession.clearStorageData.mock.calls, [
        [
          {
            storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"],
          },
        ],
      ]);
      assert.strictEqual(firstSession.clearCache.mock.calls.length, 1);
      assert.strictEqual(secondSession.clearStorageData.mock.calls.length, 0);
      assert.strictEqual(secondSession.clearCache.mock.calls.length, 0);
      assert.strictEqual(accountSession.clearStorageData.mock.calls.length, 0);
      assert.strictEqual(accountSession.clearCache.mock.calls.length, 0);
    }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );

  it.effect("keeps native secret causes out of fixed renderer-safe messages", () =>
    Effect.gen(function* () {
      const secret = "session-secret-must-not-leak";
      fromPartition.mockImplementationOnce(() => {
        throw new Error(secret);
      });
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      const error = yield* sessions.account.pipe(Effect.flip);

      assert.instanceOf(error, CtoxElectronSessions.CtoxElectronSessionOperationError);
      assert.equal(error.message, "The CTOX Electron session operation failed.");
      assert.notInclude(error.message, secret);
    }).pipe(Effect.provide(CtoxElectronSessions.layer)),
  );
});
