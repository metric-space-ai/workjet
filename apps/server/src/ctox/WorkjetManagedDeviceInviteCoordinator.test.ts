// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics preferSchemaOverJson:off -- assertions verify that the durable record contains no secret field values.
import { assert, describe, it } from "@effect/vitest";
import type {
  BusinessOsInstanceId,
  CtoxBusinessOsInviteV1,
  WorkjetManagedCtoxSyncInviteIssueResult,
  WorkjetManagedDeviceBindingRecordV1,
  WorkjetManagedDeviceSessionIssueResult,
  WorkjetDeviceSessionBootstrapCredential,
  WorkjetManagedIssuerOrigin,
  WorkjetManagedProvisioningGrantId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Coordinator from "./WorkjetManagedDeviceInviteCoordinator.ts";

const NOW = Date.parse("2099-08-27T12:00:00.000Z") / 1_000;
const REQUEST_URL = "https://managed.example.test/api/workjet/device-invites/redeem";
const INSTANCE_ID = "ctox-business-os:business-os-a" as BusinessOsInstanceId;
const THUMBPRINT = "a".repeat(43);

const portError = () =>
  new Coordinator.WorkjetManagedDeviceProvisioningPortError({ reason: "unavailable" });

const ctoxInvite = (): CtoxBusinessOsInviteV1 => ({
  type: "ctox-business-os-invite",
  version: 1,
  display_name: "Business OS A",
  instance_id: INSTANCE_ID,
  sync_room: "ctox-business-os:sync-a",
  native_peer_id: "ctox-business-os:peer-a",
  signaling_urls: ["wss://signal.example.test"],
  signaling_room_password: "room-password",
  transport: "webrtc",
  expires_at: "2099-08-27T12:05:00.000Z",
  data_plane: "rxdb-webrtc",
  http_bridge_available: false,
  secret_value_in_payload: true,
  session: {
    authenticated: true,
    source: "mobile_invite",
    capability_token: "capability-token",
    capability_expires_at_ms: (NOW + 300) * 1_000,
    user: {
      id: "device-user",
      display_name: "Workjet device",
      role: "user",
      is_admin: false,
    },
  },
});

const request = (): Coordinator.WorkjetManagedDeviceInviteRedeemRequest => ({
  intent: {
    devicePairingId: "pairing-a",
    businessOsInstanceId: INSTANCE_ID,
    expiresAtEpochSeconds: NOW + 300,
  },
  payload: {
    code: "b".repeat(43),
    deviceId: "device-a",
    proofKeyThumbprint: THUMBPRINT,
  },
  dpopProof: "signed-dpop-proof",
  requestUrl: REQUEST_URL,
});

type HarnessOptions = {
  readonly claims?: Partial<Coordinator.WorkjetManagedRedeemDpopClaims>;
  readonly sessionResult?: Partial<WorkjetManagedDeviceSessionIssueResult>;
  readonly ctoxResult?: Partial<WorkjetManagedCtoxSyncInviteIssueResult>;
  readonly sessionFailures?: number;
  readonly ctoxFailures?: number;
  readonly sessionRevokeFailures?: number;
  readonly ctoxRevokeFailures?: number;
  readonly activationFailures?: number;
};

const makeHarness = (options: HarnessOptions = {}) => {
  let sessionFailures = options.sessionFailures ?? 0;
  let ctoxFailures = options.ctoxFailures ?? 0;
  let activationFailures = options.activationFailures ?? 0;
  let sessionRevokeFailures = options.sessionRevokeFailures ?? 0;
  let ctoxRevokeFailures = options.ctoxRevokeFailures ?? 0;
  let reservation:
    | {
        readonly devicePairingId: string;
        readonly deviceId: string;
        readonly proofKeyThumbprint: string;
        readonly businessOsInstanceId: BusinessOsInstanceId;
        checkpoint: Coordinator.WorkjetManagedDeviceProvisioningCheckpoint;
      }
    | undefined;
  let activeRecord: WorkjetManagedDeviceBindingRecordV1 | undefined;
  let pendingRevocation: WorkjetManagedDeviceBindingRecordV1 | undefined;
  const sessionGrants = new Map<string, WorkjetManagedDeviceSessionIssueResult>();
  const ctoxGrants = new Map<string, WorkjetManagedCtoxSyncInviteIssueResult>();
  const activeSessionGrantIds = new Set<string>();
  const activeCtoxGrantIds = new Set<string>();
  const sessionRevocations: Array<string> = [];
  const ctoxRevocations: Array<string> = [];
  const sessionInputs: Array<{ readonly proofKeyThumbprint: string }> = [];
  let sessionIssueCalls = 0;
  let ctoxIssueCalls = 0;

  const dpop = Coordinator.WorkjetManagedRedeemDpopVerifier.of({
    verifyAndClaim: () =>
      Effect.succeed({
        proofKeyThumbprint: THUMBPRINT,
        htm: "POST",
        htu: REQUEST_URL,
        iat: NOW,
        jti: "proof-jti-a",
        replayProtected: true,
        ...options.claims,
      }),
  });

  const sessions = Coordinator.WorkjetManagedDeviceSessionIssuer.of({
    issue: (input) =>
      Effect.gen(function* () {
        sessionIssueCalls += 1;
        sessionInputs.push({ proofKeyThumbprint: input.proofKeyThumbprint });
        if (sessionFailures > 0) {
          sessionFailures -= 1;
          return yield* portError();
        }
        const result =
          sessionGrants.get(input.devicePairingId) ??
          ({
            grantId: "c".repeat(43) as WorkjetManagedProvisioningGrantId,
            businessOsInstanceId: INSTANCE_ID,
            deviceId: "device-a",
            proofKeyThumbprint: THUMBPRINT,
            issuer: "https://managed.example.test" as WorkjetManagedIssuerOrigin,
            bootstrapCredential: "e".repeat(43) as WorkjetDeviceSessionBootstrapCredential,
            expiresAt: "2099-08-27T12:05:00.000Z",
            ...options.sessionResult,
          } satisfies WorkjetManagedDeviceSessionIssueResult);
        sessionGrants.set(input.devicePairingId, result);
        activeSessionGrantIds.add(result.grantId);
        return result;
      }),
    revoke: (input) =>
      Effect.gen(function* () {
        sessionRevocations.push(input.grantId);
        if (sessionRevokeFailures > 0) {
          sessionRevokeFailures -= 1;
          return yield* portError();
        }
        activeSessionGrantIds.delete(input.grantId);
      }),
  });

  const ctox = Coordinator.WorkjetManagedCtoxSyncInviteIssuer.of({
    issue: (input) =>
      Effect.gen(function* () {
        ctoxIssueCalls += 1;
        if (ctoxFailures > 0) {
          ctoxFailures -= 1;
          return yield* portError();
        }
        const result =
          ctoxGrants.get(input.devicePairingId) ??
          ({
            grantId: "d".repeat(43) as WorkjetManagedProvisioningGrantId,
            businessOsInstanceId: INSTANCE_ID,
            deviceId: "device-a",
            proofKeyThumbprint: THUMBPRINT,
            invite: ctoxInvite(),
            expiresAt: "2099-08-27T12:05:00.000Z",
            ...options.ctoxResult,
          } satisfies WorkjetManagedCtoxSyncInviteIssueResult);
        ctoxGrants.set(input.devicePairingId, result);
        activeCtoxGrantIds.add(result.grantId);
        return result;
      }),
    revoke: (input) =>
      Effect.gen(function* () {
        ctoxRevocations.push(input.grantId);
        if (ctoxRevokeFailures > 0) {
          ctoxRevokeFailures -= 1;
          return yield* portError();
        }
        activeCtoxGrantIds.delete(input.grantId);
      }),
  });

  const bindings = Coordinator.WorkjetManagedDeviceBindingStore.of({
    reserve: (input) =>
      Effect.gen(function* () {
        if (activeRecord !== undefined) return { _tag: "active" as const, record: activeRecord };
        if (reservation === undefined) {
          reservation = { ...input, checkpoint: { phase: "provisioning" } };
          return { _tag: "reserved" as const };
        }
        if (
          reservation.devicePairingId !== input.devicePairingId ||
          reservation.deviceId !== input.deviceId ||
          reservation.proofKeyThumbprint !== input.proofKeyThumbprint ||
          reservation.businessOsInstanceId !== input.businessOsInstanceId
        ) {
          return yield* new Coordinator.WorkjetManagedDeviceProvisioningPortError({
            reason: "conflict",
          });
        }
        return { _tag: "resumed" as const, checkpoint: reservation.checkpoint };
      }),
    checkpoint: (input) =>
      Effect.gen(function* () {
        if (reservation === undefined || reservation.devicePairingId !== input.devicePairingId) {
          return yield* new Coordinator.WorkjetManagedDeviceProvisioningPortError({
            reason: "conflict",
          });
        }
        reservation.checkpoint = input.checkpoint;
      }),
    activate: (record) =>
      Effect.gen(function* () {
        if (activationFailures > 0) {
          activationFailures -= 1;
          return yield* portError();
        }
        activeRecord = record;
        reservation = undefined;
      }),
    release: () =>
      Effect.sync(() => {
        reservation = undefined;
      }),
    beginRevocation: (input) =>
      Effect.gen(function* () {
        const record = pendingRevocation ?? activeRecord;
        if (record === undefined) return { _tag: "missing" as const };
        if (
          record.devicePairingId !== input.devicePairingId ||
          record.businessOsInstanceId !== input.businessOsInstanceId
        ) {
          return yield* new Coordinator.WorkjetManagedDeviceProvisioningPortError({
            reason: "conflict",
          });
        }
        pendingRevocation = { ...record, state: "revoking" };
        activeRecord = undefined;
        return { _tag: "pending" as const, record: pendingRevocation };
      }),
    finalizeRevocation: (input) =>
      Effect.gen(function* () {
        if (
          pendingRevocation === undefined ||
          pendingRevocation.devicePairingId !== input.devicePairingId ||
          pendingRevocation.businessOsInstanceId !== input.businessOsInstanceId
        ) {
          return yield* new Coordinator.WorkjetManagedDeviceProvisioningPortError({
            reason: "conflict",
          });
        }
        pendingRevocation = undefined;
      }),
  });

  const layer = Layer.mergeAll(
    Layer.succeed(Coordinator.WorkjetManagedRedeemDpopVerifier, dpop),
    Layer.succeed(Coordinator.WorkjetManagedDeviceSessionIssuer, sessions),
    Layer.succeed(Coordinator.WorkjetManagedCtoxSyncInviteIssuer, ctox),
    Layer.succeed(Coordinator.WorkjetManagedDeviceBindingStore, bindings),
  );

  return {
    layer,
    state: {
      activeSessionGrantIds,
      activeCtoxGrantIds,
      sessionRevocations,
      ctoxRevocations,
      sessionInputs,
      get activeRecord() {
        return activeRecord;
      },
      get sessionIssueCalls() {
        return sessionIssueCalls;
      },
      get ctoxIssueCalls() {
        return ctoxIssueCalls;
      },
      get issuedSessionGrantCount() {
        return sessionGrants.size;
      },
      get issuedCtoxGrantCount() {
        return ctoxGrants.size;
      },
      get checkpoint() {
        return reservation?.checkpoint;
      },
      get pendingRevocation() {
        return pendingRevocation;
      },
    },
  };
};

const makeCoordinator = (harness: ReturnType<typeof makeHarness>) =>
  Coordinator.make({ nowEpochSeconds: () => NOW }).pipe(Effect.provide(harness.layer));

describe("WorkjetManagedDeviceInviteCoordinator", () => {
  it.effect("binds the verified DPoP key and persists only the secret-free edge", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* makeCoordinator(harness);
      const result = yield* coordinator.redeem(request());

      assert.equal(result.version, 2);
      assert.equal(result.business_os_instance_id, INSTANCE_ID);
      assert.equal(result.business_os.instance_id, INSTANCE_ID);
      assert.equal(harness.state.sessionInputs[0]?.proofKeyThumbprint, THUMBPRINT);
      assert.equal(harness.state.activeRecord?.proofKeyThumbprint, THUMBPRINT);
      assert.notProperty(result, "environment");
      assert.notProperty(result, "code_environments");
      const persisted = JSON.stringify(harness.state.activeRecord);
      assert.notInclude(persisted, "e".repeat(43));
      assert.notInclude(persisted, "room-password");
      assert.notInclude(persisted, "capability-token");
    });
  });

  it.effect(
    "rolls back a device session when CTOX issuance fails, then retries without duplicate grants",
    () => {
      const harness = makeHarness({ ctoxFailures: 1 });
      return Effect.gen(function* () {
        const coordinator = yield* makeCoordinator(harness);
        const first = yield* Effect.flip(coordinator.redeem(request()));
        assert.equal(first.reason, "unavailable");
        assert.lengthOf(harness.state.sessionRevocations, 1);
        assert.equal(harness.state.activeSessionGrantIds.size, 0);

        const result = yield* coordinator.redeem(request());
        assert.equal(result.device_pairing_id, "pairing-a");
        assert.equal(harness.state.activeSessionGrantIds.size, 1);
        assert.equal(harness.state.activeCtoxGrantIds.size, 1);
        assert.equal(harness.state.activeRecord?.deviceSessionGrantId, "c".repeat(43));
        assert.equal(harness.state.sessionIssueCalls, 2);
        assert.equal(harness.state.ctoxIssueCalls, 2);
        assert.equal(harness.state.issuedSessionGrantCount, 1);
        assert.equal(harness.state.issuedCtoxGrantCount, 1);
      });
    },
  );

  it.effect("rolls back a CTOX grant when device-session issuance fails", () => {
    const harness = makeHarness({ sessionFailures: 1 });
    return Effect.gen(function* () {
      const coordinator = yield* makeCoordinator(harness);
      const first = yield* Effect.flip(coordinator.redeem(request()));
      assert.equal(first.reason, "unavailable");
      assert.lengthOf(harness.state.ctoxRevocations, 1);
      assert.equal(harness.state.activeCtoxGrantIds.size, 0);

      yield* coordinator.redeem(request());
      assert.equal(harness.state.activeSessionGrantIds.size, 1);
      assert.equal(harness.state.activeCtoxGrantIds.size, 1);
    });
  });

  it.effect("finishes a failed compensation before issuing a new generation", () => {
    const harness = makeHarness({ ctoxFailures: 1, sessionRevokeFailures: 1 });
    return Effect.gen(function* () {
      const coordinator = yield* makeCoordinator(harness);
      const first = yield* Effect.flip(coordinator.redeem(request()));
      assert.equal(first.reason, "unavailable");
      assert.equal(harness.state.checkpoint?.phase, "revoking");
      assert.equal(harness.state.sessionIssueCalls, 1);
      assert.equal(harness.state.activeSessionGrantIds.size, 1);

      const compensationRetry = yield* Effect.flip(coordinator.redeem(request()));
      assert.equal(compensationRetry.reason, "unavailable");
      assert.equal(harness.state.sessionIssueCalls, 1);
      assert.equal(harness.state.ctoxIssueCalls, 1);
      assert.equal(harness.state.activeSessionGrantIds.size, 0);

      yield* coordinator.redeem(request());
      assert.equal(harness.state.issuedSessionGrantCount, 1);
      assert.equal(harness.state.issuedCtoxGrantCount, 1);
      assert.equal(harness.state.activeSessionGrantIds.size, 1);
      assert.equal(harness.state.activeCtoxGrantIds.size, 1);
    });
  });

  it.effect("rolls both grants back when durable binding activation fails", () => {
    const harness = makeHarness({ activationFailures: 1 });
    return Effect.gen(function* () {
      const coordinator = yield* makeCoordinator(harness);
      const first = yield* Effect.flip(coordinator.redeem(request()));
      assert.equal(first.reason, "unavailable");
      assert.lengthOf(harness.state.sessionRevocations, 1);
      assert.lengthOf(harness.state.ctoxRevocations, 1);
      assert.equal(harness.state.activeSessionGrantIds.size, 0);
      assert.equal(harness.state.activeCtoxGrantIds.size, 0);

      yield* coordinator.redeem(request());
      assert.equal(harness.state.activeSessionGrantIds.size, 1);
      assert.equal(harness.state.activeCtoxGrantIds.size, 1);
      assert.isDefined(harness.state.activeRecord);
    });
  });

  it.effect("keeps edge revocation pending until both downstream grants are revoked", () => {
    const harness = makeHarness({ sessionRevokeFailures: 1 });
    return Effect.gen(function* () {
      const coordinator = yield* makeCoordinator(harness);
      yield* coordinator.redeem(request());

      const first = yield* Effect.flip(
        coordinator.revokeBinding({
          businessOsInstanceId: INSTANCE_ID,
          devicePairingId: "pairing-a",
        }),
      );
      assert.equal(first.reason, "unavailable");
      assert.equal(harness.state.pendingRevocation?.state, "revoking");

      const result = yield* coordinator.revokeBinding({
        businessOsInstanceId: INSTANCE_ID,
        devicePairingId: "pairing-a",
      });
      assert.equal(result.revoked, true);
      assert.isUndefined(harness.state.pendingRevocation);
      assert.equal(harness.state.activeSessionGrantIds.size, 0);
      assert.equal(harness.state.activeCtoxGrantIds.size, 0);
    });
  });

  for (const [label, options] of [
    [
      "session instance",
      { sessionResult: { businessOsInstanceId: "other" as BusinessOsInstanceId } },
    ],
    ["session device", { sessionResult: { deviceId: "other-device" } }],
    ["session proof key", { sessionResult: { proofKeyThumbprint: "z".repeat(43) } }],
    ["CTOX device", { ctoxResult: { deviceId: "other-device" } }],
    ["CTOX proof key", { ctoxResult: { proofKeyThumbprint: "z".repeat(43) } }],
    ["session expiry", { sessionResult: { expiresAt: "2099-08-27T12:06:00.000Z" } }],
    ["CTOX expiry", { ctoxResult: { expiresAt: "2099-08-27T12:06:00.000Z" } }],
  ] as const) {
    it.effect(`rejects a mismatched ${label} issuer echo before activation`, () => {
      const harness = makeHarness(options);
      return Effect.gen(function* () {
        const coordinator = yield* makeCoordinator(harness);
        const error = yield* Effect.flip(coordinator.redeem(request()));
        assert.equal(error.reason, "rejected");
        assert.isUndefined(harness.state.activeRecord);
        assert.equal(harness.state.activeSessionGrantIds.size, 0);
        assert.equal(harness.state.activeCtoxGrantIds.size, 0);
      });
    });
  }

  for (const [label, claims] of [
    ["thumbprint", { proofKeyThumbprint: "z".repeat(43) }],
    ["method", { htm: "GET" }],
    ["target URL", { htu: `${REQUEST_URL}/wrong` }],
    ["issued-at window", { iat: NOW - 301 }],
    ["empty JTI", { jti: "" }],
    ["replay protection", { replayProtected: false }],
  ] as const) {
    it.effect(`rejects a DPoP ${label} mismatch before provisioning`, () => {
      const harness = makeHarness({ claims });
      return Effect.gen(function* () {
        const coordinator = yield* makeCoordinator(harness);
        const error = yield* Effect.flip(coordinator.redeem(request()));
        assert.equal(error.reason, "rejected");
        assert.equal(harness.state.sessionIssueCalls, 0);
        assert.equal(harness.state.ctoxIssueCalls, 0);
      });
    });
  }
});
