// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import {
  CtoxInstanceRegistryError,
  make,
  mergeCtoxInstanceSources,
  parseCtoxPairingInvite,
} from "./CtoxInstanceRegistry.ts";

const NOW = 1_800_000_000_000;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const manualPairing = {
  displayName: "Office Business OS",
  instanceId: "office-1",
  syncRoom: "ctox-business-os:office-room",
  signalingUrls: ["wss://signal.example.com/room"],
  roomSecret: "raw-room-secret",
  capabilityToken: "raw-capability-token",
  capabilityExpiresAtMs: NOW + 60_000,
  role: "admin",
  userId: "private-user-id",
} as const;

function invite(overrides: Record<string, unknown> = {}): string {
  const linkPayload = Buffer.from(
    '{"type":"ctox-business-os-invite","version":1}',
    "utf8",
  ).toString("base64url");
  return JSON.stringify({
    type: "ctox-business-os-invite",
    version: 1,
    display_name: "Invited Business OS",
    instance_id: "office-1",
    native_peer_id: "native-peer-1",
    sync_room: "ctox-business-os:office-room",
    signaling_urls: ["wss://signal.example.com/room"],
    signaling_room_password: "raw-invite-secret",
    transport: "webrtc",
    expires_at_ms: NOW + 60_000,
    data_plane: "rxdb-webrtc",
    http_bridge_available: false,
    secret_value_in_payload: true,
    desktop_link: `ctox-business-os-desktop://pair?payload=${linkPayload}`,
    session: {
      authenticated: true,
      source: "desktop_invite",
      capability_token: "raw-invite-capability",
      capability_expires_at_ms: NOW + 60_000,
      user: {
        id: "private-user-id",
        display_name: "Private User",
        role: "admin",
        is_admin: true,
      },
    },
    ...overrides,
  });
}

function fileError(method: string, path: string, tag: PlatformError.SystemErrorTag = "NotFound") {
  return PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });
}

interface MemoryFileSystem {
  readonly files: Map<string, string>;
  readonly failRenameTo: Set<string>;
  readonly failRenameOnAttempt: Map<string, number>;
  readonly renameAttempts: Map<string, number>;
  readonly service: FileSystem.FileSystem;
}

function makeMemoryFileSystem(): MemoryFileSystem {
  const files = new Map<string, string>();
  const failRenameTo = new Set<string>();
  const failRenameOnAttempt = new Map<string, number>();
  const renameAttempts = new Map<string, number>();
  const service = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    readFileString: (path) =>
      files.has(path)
        ? Effect.succeed(files.get(path) ?? "")
        : Effect.fail(fileError("readFileString", path)),
    writeFileString: (path, contents) => Effect.sync(() => void files.set(path, contents)),
    rename: (oldPath, newPath) =>
      Effect.suspend(() => {
        const attempt = (renameAttempts.get(newPath) ?? 0) + 1;
        renameAttempts.set(newPath, attempt);
        if (failRenameTo.has(newPath) || failRenameOnAttempt.get(newPath) === attempt) {
          return Effect.fail(fileError("rename", newPath, "PermissionDenied"));
        }
        const contents = files.get(oldPath);
        if (contents === undefined) return Effect.fail(fileError("rename", oldPath));
        files.delete(oldPath);
        files.set(newPath, contents);
        return Effect.void;
      }),
  });
  return { files, failRenameTo, failRenameOnAttempt, renameAttempts, service };
}

function safeStorage(
  input: {
    readonly available?: boolean;
    readonly backend?: string;
    readonly failEncrypt?: boolean;
    readonly failDecrypt?: boolean;
  } = {},
): ElectronSafeStorage.ElectronSafeStorage["Service"] {
  return ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(input.available ?? true),
    encryptString: (value) =>
      input.failEncrypt === true
        ? Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageEncryptError({ cause: "encrypt failed" }),
          )
        : Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      if (input.failDecrypt === true) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({ cause: "decrypt failed" }),
        );
      }
      const decoded = textDecoder.decode(value);
      return decoded.startsWith("encrypted:")
        ? Effect.succeed(decoded.slice("encrypted:".length))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageDecryptError({
              cause: "invalid ciphertext",
            }),
          );
    },
    selectedStorageBackend: Effect.succeed(
      input.backend === undefined ? Option.none() : Option.some(input.backend),
    ),
  });
}

function registryHarness(
  input: {
    readonly fileSystem?: MemoryFileSystem;
    readonly storage?: ElectronSafeStorage.ElectronSafeStorage["Service"];
    readonly nowEpochMs?: () => number;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const memory = input.fileSystem ?? makeMemoryFileSystem();
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/state",
    platform: input.platform ?? "darwin",
  } as DesktopEnvironment.DesktopEnvironment["Service"]);
  const registry = make({ nowEpochMs: input.nowEpochMs ?? (() => NOW) }).pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, input.storage ?? safeStorage()),
    Effect.provideService(FileSystem.FileSystem, memory.service),
    Effect.provide(NodeServices.layer),
  );
  return { memory, registry };
}

function failureCode(
  result: Result.Result<unknown, CtoxInstanceRegistryError>,
): string | undefined {
  return Result.isFailure(result) ? result.failure.code : undefined;
}

describe("CtoxInstanceRegistry", () => {
  it.effect("imports paired metadata and encrypted secrets into separate documents", () => {
    const { memory, registry } = registryHarness();
    return Effect.gen(function* () {
      const service = yield* registry;
      const instance = yield* service.importManualPairing(manualPairing);
      assert.equal(instance.source, "manual_pairing");
      assert.equal(instance.status, "paired");
      assert.isFalse(instance.healthSummary.dataPlaneReady);
      assert.isFalse(instance.healthSummary.nativePeerObserved);

      const publicRaw = memory.files.get("/state/ctox/instances.json") ?? "";
      const secretsRaw = memory.files.get("/state/ctox/secrets.json") ?? "";
      assert.include(publicRaw, instance.id);
      assert.notInclude(publicRaw, "sync_room");
      assert.notInclude(publicRaw, "office-room");
      assert.notInclude(publicRaw, "private-user-id");
      assert.notInclude(publicRaw, "raw-room-secret");
      assert.notInclude(secretsRaw, "raw-room-secret");
      assert.notInclude(secretsRaw, "raw-capability-token");
      assert.include(secretsRaw, "ciphertext");

      const merged = yield* service.merge({ _tag: "signed_out" });
      assert.equal(merged._tag, "ready");
      if (merged._tag === "ready") {
        assert.equal(merged.managedState, "signed_out");
        assert.deepEqual(merged.instances, [instance]);
      }
    });
  });

  it.effect(
    "resolves exact invite and manual WebRTC launch configs without exposing secrets",
    () => {
      const { memory, registry } = registryHarness();
      return Effect.gen(function* () {
        const service = yield* registry;
        assert.isFunction(service.resolvePairedLaunch);
        const invited = yield* service.importInvite(invite());
        const inviteLaunch = yield* service.resolvePairedLaunch!(invited.id);
        assert.deepEqual(inviteLaunch.descriptor, invited);
        assert.deepEqual(inviteLaunch.config, {
          transport: "webrtc",
          sync_room: "ctox-business-os:office-room",
          signaling_urls: ["wss://signal.example.com/room"],
          signaling_room_password: "raw-invite-secret",
          http_bridge_available: false,
          desktop_instance: {
            id: invited.id,
            source: "pairing_invite",
            display_name: "Invited Business OS",
            domain: "",
          },
          session: {
            authenticated: true,
            source: "desktop_invite",
            capability_token: "raw-invite-capability",
            capability_expires_at_ms: NOW + 60_000,
            user: {
              id: "private-user-id",
              display_name: "Private User",
              role: "admin",
              is_admin: true,
            },
          },
        });

        const manual = yield* service.importManualPairing(manualPairing);
        const manualLaunch = yield* service.resolvePairedLaunch!(manual.id);
        assert.deepEqual(manualLaunch.config.session, {
          authenticated: true,
          source: "desktop_manual_pairing",
          capability_token: "raw-capability-token",
          capability_expires_at_ms: NOW + 60_000,
          user: { id: "private-user-id", role: "admin", is_admin: true },
        });
        assert.equal(manualLaunch.config.desktop_instance.source, "manual_pairing");
        assert.notInclude(
          encodeUnknownJson(yield* service.merge({ _tag: "signed_out" })),
          "raw-room-secret",
        );
        assert.notInclude(memory.files.get("/state/ctox/instances.json") ?? "", "raw-room-secret");
      });
    },
  );

  it.effect(
    "omits sessions without a token and rejects missing, expired, fake, and corrupt records",
    () => {
      let now = NOW;
      const { memory, registry } = registryHarness({ nowEpochMs: () => now });
      return Effect.gen(function* () {
        const service = yield* registry;
        assert.isFunction(service.resolvePairedLaunch);
        const withoutToken = yield* service.importManualPairing({
          displayName: manualPairing.displayName,
          instanceId: manualPairing.instanceId,
          syncRoom: manualPairing.syncRoom,
          signalingUrls: manualPairing.signalingUrls,
          roomSecret: manualPairing.roomSecret,
          role: manualPairing.role,
          userId: manualPairing.userId,
        });
        const launch = yield* service.resolvePairedLaunch!(withoutToken.id);
        assert.isUndefined(launch.config.session);

        const fakeId = "paired:manual_pairing:abcdefghijklmnopqrstuv";
        const fake = yield* Effect.result(service.resolvePairedLaunch!(fakeId));
        assert.equal(failureCode(fake), "not_found");

        const missing = yield* Effect.result(
          service.resolvePairedLaunch!("paired:pairing_invite:abcdefghijklmnopqrstuv"),
        );
        assert.equal(failureCode(missing), "not_found");

        const expiring = yield* service.importManualPairing(manualPairing);
        now = NOW + 60_000;
        const expired = yield* Effect.result(service.resolvePairedLaunch!(expiring.id));
        assert.equal(failureCode(expired), "not_found");

        now = NOW;
        const secretDocument = decodeUnknownJson(
          memory.files.get("/state/ctox/secrets.json") ?? "{}",
        ) as {
          records: Array<{ id: string; ciphertext: string }>;
        };
        const target = secretDocument.records.find((record) => record.id === withoutToken.id);
        assert.isDefined(target);
        target.ciphertext = Buffer.from('encrypted:{"version":1}', "utf8").toString("base64");
        memory.files.set("/state/ctox/secrets.json", `${encodeUnknownJson(secretDocument)}\n`);
        const corrupt = yield* Effect.result(service.resolvePairedLaunch!(withoutToken.id));
        assert.equal(failureCode(corrupt), "persistence_failed");
        if (Result.isFailure(corrupt)) {
          assert.equal(
            corrupt.failure.message,
            "The CTOX paired instance registry operation failed.",
          );
          assert.notInclude(corrupt.failure.message, "raw-room-secret");
        }
      });
    },
  );

  it.effect("uses source-namespaced stable ids and deterministic merge ordering", () => {
    const { registry } = registryHarness();
    return Effect.gen(function* () {
      const service = yield* registry;
      const manual = yield* service.importManualPairing(manualPairing);
      const sameManual = yield* service.importManualPairing({
        ...manualPairing,
        displayName: "Updated Office",
      });
      const invited = yield* service.importInvite(invite());
      assert.equal(sameManual.id, manual.id);
      assert.notEqual(invited.id, manual.id);

      const merged = yield* service.merge({
        _tag: "ready",
        instances: [
          {
            id: "managed:z",
            source: "ctox_dev",
            displayName: "Zulu",
            status: "available",
            healthSummary: {
              dataPlane: "rxdb-webrtc",
              dataPlaneReady: true,
              httpDataProxy: false,
              nativePeerObserved: true,
            },
          },
        ],
      });
      assert.equal(merged._tag, "ready");
      if (merged._tag === "ready") {
        assert.deepEqual(
          merged.instances.map((entry) => entry.source),
          ["ctox_dev", "pairing_invite", "manual_pairing"],
        );
        assert.equal(merged.managedState, "ready");
      }
    });
  });

  it.effect("resolves an opaque stable identity key that survives re-pairing", () => {
    const { memory, registry } = registryHarness();
    return Effect.gen(function* () {
      const service = yield* registry;
      const manual = yield* service.importManualPairing(manualPairing);
      const manualKey = yield* service.stableIdentityKey(manual.id);
      assert.match(manualKey, /^ctox:[A-Za-z0-9_-]{22}$/);
      // The identity is instance-scoped, not id- or source-scoped: the same
      // CTOX instance keeps its key across pairing sources and re-imports.
      const invited = yield* service.importInvite(invite());
      assert.notEqual(invited.id, manual.id);
      assert.equal(yield* service.stableIdentityKey(invited.id), manualKey);
      const other = yield* service.importManualPairing({
        ...manualPairing,
        instanceId: "other-office",
      });
      assert.notEqual(yield* service.stableIdentityKey(other.id), manualKey);
      // The raw identity never reaches the key or the public document.
      assert.notInclude(manualKey, manualPairing.instanceId);
      assert.notInclude(memory.files.get("/state/ctox/instances.json") ?? "", "office-1");

      const missing = yield* Effect.result(
        service.stableIdentityKey("paired:manual_pairing:abcdefghijklmnopqrstuv"),
      );
      assert.equal(failureCode(missing), "not_found");
      const managed = yield* Effect.result(service.stableIdentityKey("managed:tenant"));
      assert.equal(failureCode(managed), "not_found");
    });
  });

  it.effect("rejects expired, bridged, oversized, malformed-room, and dangerous URL inputs", () =>
    Effect.gen(function* () {
      const invalidInvites = [
        invite({ expires_at_ms: NOW }),
        invite({ capability_expires_at_ms: NOW }),
        invite({
          session: {
            authenticated: true,
            source: "desktop_invite",
            capability_token: "raw-invite-capability",
            capability_expires_at_ms: NOW,
          },
        }),
        invite({
          capability_token: "conflicting-capability",
          session: {
            authenticated: true,
            source: "desktop_invite",
            capability_token: "raw-invite-capability",
            capability_expires_at_ms: NOW + 60_000,
          },
        }),
        invite({
          capability_token: "raw-invite-capability",
          session: {
            authenticated: true,
            source: "desktop_invite",
            capability_token: "conflicting-capability",
            capability_expires_at_ms: NOW + 60_000,
          },
        }),
        invite({ nested: { http_bridge: { enabled: true } } }),
        invite({ nested: Array.from({ length: 65 }, () => false) }),
        invite({ sync_room: "wrong:room" }),
        invite({ signaling_urls: ["ws://signal.example.com/room"] }),
        invite({ signaling_urls: ["wss://user:password@signal.example.com/room"] }),
        invite({ signaling_urls: ["wss://signal.example.com/room#credential"] }),
        invite({ signaling_urls: ["wss://signal.example.com/room?token=credential"] }),
        "x".repeat(65_537),
      ];
      for (const raw of invalidInvites) {
        const result = yield* Effect.result(parseCtoxPairingInvite(raw, NOW));
        assert.equal(failureCode(result), "invalid_invite");
      }

      const { registry } = registryHarness();
      const service = yield* registry;
      for (const input of [
        { ...manualPairing, signalingUrls: ["http://signal.example.com"] },
        { ...manualPairing, signalingUrls: ["ws://192.168.1.2"] },
        { ...manualPairing, signalingUrls: ["wss://signal.example.com/#token"] },
        { ...manualPairing, capabilityExpiresAtMs: NOW },
      ]) {
        const result = yield* Effect.result(service.importManualPairing(input));
        assert.equal(failureCode(result), "invalid_input");
      }
      const loopback = yield* service.importManualPairing({
        ...manualPairing,
        signalingUrls: ["ws://127.0.0.1:8080/room"],
      });
      assert.equal(loopback.source, "manual_pairing");
    }),
  );

  it.effect("fails closed when safe storage is unavailable, basic_text, or encryption fails", () =>
    Effect.gen(function* () {
      for (const storage of [
        safeStorage({ available: false }),
        safeStorage({ backend: "basic_text" }),
        safeStorage({ failEncrypt: true }),
      ]) {
        const memory = makeMemoryFileSystem();
        const { registry } = registryHarness({ fileSystem: memory, storage });
        const service = yield* registry;
        const result = yield* Effect.result(service.importManualPairing(manualPairing));
        assert.equal(failureCode(result), "unsafe_secret_storage");
        assert.isFalse(memory.files.has("/state/ctox/instances.json"));
      }

      const linuxMemory = makeMemoryFileSystem();
      const { registry: linuxRegistry } = registryHarness({
        fileSystem: linuxMemory,
        storage: safeStorage(),
        platform: "linux",
      });
      const linuxResult = yield* Effect.result(
        (yield* linuxRegistry).importManualPairing(manualPairing),
      );
      assert.equal(failureCode(linuxResult), "unsafe_secret_storage");
      assert.isFalse(linuxMemory.files.has("/state/ctox/instances.json"));
    }),
  );

  it.effect("does not write secrets when fail-closed metadata staging fails", () => {
    const memory = makeMemoryFileSystem();
    memory.failRenameTo.add("/state/ctox/instances.json");
    const { registry } = registryHarness({ fileSystem: memory });
    return Effect.gen(function* () {
      const service = yield* registry;
      const result = yield* Effect.result(service.importManualPairing(manualPairing));
      assert.equal(failureCode(result), "persistence_failed");
      assert.isFalse(memory.files.has("/state/ctox/secrets.json"));
      assert.isFalse(memory.files.has("/state/ctox/instances.json"));
      assert.deepEqual(yield* service.merge({ _tag: "signed_out" }), { _tag: "signed_out" });
    });
  });

  it.effect("removes an existing public target before updating its encrypted secret", () => {
    const memory = makeMemoryFileSystem();
    const { registry } = registryHarness({ fileSystem: memory });
    return Effect.gen(function* () {
      const service = yield* registry;
      const instance = yield* service.importManualPairing(manualPairing);
      const currentAttempts = memory.renameAttempts.get("/state/ctox/instances.json") ?? 0;
      memory.failRenameOnAttempt.set("/state/ctox/instances.json", currentAttempts + 2);

      const result = yield* Effect.result(
        service.importManualPairing({ ...manualPairing, displayName: "Updated Office" }),
      );
      assert.equal(failureCode(result), "persistence_failed");
      assert.notInclude(memory.files.get("/state/ctox/instances.json") ?? "", instance.id);
      assert.deepEqual(yield* service.merge({ _tag: "signed_out" }), { _tag: "signed_out" });
    });
  });

  it.effect(
    "preserves managed discovery and refuses to overwrite corrupt registry documents",
    () => {
      const memory = makeMemoryFileSystem();
      memory.files.set("/state/ctox/instances.json", '{"rawSecret":"do-not-leak"}');
      memory.files.set("/state/ctox/secrets.json", '{"version":1,"records":"corrupt"}');
      const { registry } = registryHarness({ fileSystem: memory });
      return Effect.gen(function* () {
        const service = yield* registry;
        const managed = { _tag: "failed", code: "network_error" } as const;
        assert.deepEqual(yield* service.merge(managed), managed);
        const before = memory.files.get("/state/ctox/secrets.json");
        const result = yield* Effect.result(service.importManualPairing(manualPairing));
        assert.equal(failureCode(result), "persistence_failed");
        assert.equal(memory.files.get("/state/ctox/secrets.json"), before);
      });
    },
  );

  it.effect(
    "removes public metadata before secrets and keeps paired entries across managed failure",
    () => {
      const memory = makeMemoryFileSystem();
      const { registry } = registryHarness({ fileSystem: memory });
      return Effect.gen(function* () {
        const service = yield* registry;
        const instance = yield* service.importManualPairing(manualPairing);
        const retained = yield* service.merge({
          _tag: "failed",
          code: "http_error",
          httpStatus: 503,
        });
        assert.equal(retained._tag, "ready");
        if (retained._tag === "ready") {
          assert.equal(retained.managedState, "failed");
          assert.equal(retained.managedFailureCode, "http_error");
        }

        memory.failRenameTo.add("/state/ctox/secrets.json");
        const removal = yield* service.removePairedInstance(instance.id);
        assert.deepEqual(removal, { descriptor: instance, secretRecordRemoved: false });
        const publicRaw = memory.files.get("/state/ctox/instances.json") ?? "";
        assert.notInclude(publicRaw, instance.id);
        assert.include(memory.files.get("/state/ctox/secrets.json") ?? "", instance.id);
        assert.deepEqual(yield* service.merge({ _tag: "signed_out" }), { _tag: "signed_out" });
      });
    },
  );

  it.effect("returns and removes the validated stored descriptor even after pairing expiry", () => {
    let now = NOW;
    const { memory, registry } = registryHarness({ nowEpochMs: () => now });
    return Effect.gen(function* () {
      const service = yield* registry;
      const stored = yield* service.importManualPairing(manualPairing);
      now = NOW + 60_000;

      const merged = yield* service.merge({ _tag: "signed_out" });
      assert.equal(merged._tag, "ready");
      if (merged._tag === "ready") {
        assert.equal(merged.instances[0]?.status, "pairing_expired");
      }

      const removed = yield* service.removePairedInstance(stored.id);
      assert.deepEqual(removed, { descriptor: stored, secretRecordRemoved: true });
      assert.equal(removed.descriptor.status, "paired");
      assert.notInclude(encodeUnknownJson(removed.descriptor), "raw-room-secret");
      assert.notInclude(memory.files.get("/state/ctox/instances.json") ?? "", stored.id);
      assert.notInclude(memory.files.get("/state/ctox/secrets.json") ?? "", stored.id);
    });
  });

  it.effect("rejects malformed ids and corrupted persisted removal descriptors", () => {
    const { memory, registry } = registryHarness();
    return Effect.gen(function* () {
      const service = yield* registry;
      const stored = yield* service.importManualPairing(manualPairing);

      assert.equal(
        failureCode(yield* Effect.result(service.removePairedInstance("managed:tenant"))),
        "managed_not_removable",
      );
      assert.equal(
        failureCode(
          yield* Effect.result(service.removePairedInstance("paired:manual_pairing:malformed")),
        ),
        "not_found",
      );

      const publicDocument = decodeUnknownJson(
        memory.files.get("/state/ctox/instances.json") ?? "{}",
      ) as { instances: Array<{ status: string }> };
      const descriptor = publicDocument.instances[0];
      assert.isDefined(descriptor);
      descriptor.status = "pairing_expired";
      memory.files.set("/state/ctox/instances.json", `${encodeUnknownJson(publicDocument)}\n`);

      const corrupted = yield* Effect.result(service.removePairedInstance(stored.id));
      assert.equal(failureCode(corrupted), "persistence_failed");
      assert.include(memory.files.get("/state/ctox/instances.json") ?? "", stored.id);
      assert.include(memory.files.get("/state/ctox/secrets.json") ?? "", stored.id);
    });
  });

  it.effect("marks a stored capability expired using the injected clock", () => {
    let now = NOW;
    const { registry } = registryHarness({ nowEpochMs: () => now });
    return Effect.gen(function* () {
      const service = yield* registry;
      const instance = yield* service.importManualPairing(manualPairing);
      now = NOW + 60_000;
      const merged = yield* service.merge({ _tag: "signed_out" });
      assert.equal(merged._tag, "ready");
      if (merged._tag === "ready") {
        assert.equal(merged.instances[0]?.id, instance.id);
        assert.equal(merged.instances[0]?.status, "pairing_expired");
      }
    });
  });

  it("preserves the original managed result when no paired entries exist", () => {
    const managed = { _tag: "failed", code: "network_error" } as const;
    expect(mergeCtoxInstanceSources(managed, [])).toBe(managed);
  });

  it.effect("accepts a single canonical desktop invite link", () => {
    const payload = Encoding.encodeBase64Url(invite());
    return Effect.gen(function* () {
      const parsed = yield* parseCtoxPairingInvite(
        `ctox-business-os-desktop://pair?payload=${payload}`,
        NOW,
      );
      assert.equal(parsed.source, "pairing_invite");
      assert.equal(parsed.instanceIdentity, "office-1");
    });
  });
});
