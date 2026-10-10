import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConnectionId,
  type ServerSettings,
  type WorkjetConnectionSummary,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import {
  makeNativeSupervisorSourceEnrollment,
  nativeSupervisorSourceArguments,
  type NativeSupervisorSourceSelection,
  type NativeSupervisorManagedRuntime,
} from "./NativeSupervisorSourceEnrollment.ts";

const selection: NativeSupervisorSourceSelection = {
  environmentId: EnvironmentId.make("registered-gpu3-fixture"),
  computerId: WorkjetComputerId.make("native-issued-computer-fixture"),
  connectionId: WorkjetConnectionId.make("owner-source-fixture"),
  instanceId: "managed:presentation-fixture",
  nativeInstanceId: "biz_canonical-fixture",
};
const runtime: NativeSupervisorManagedRuntime = {
  ctoxExecutable: "/managed/native/bin/ctox",
  nativeRoot: "/original/native-account-root",
};
const startup = {
  protocolVersion: 1,
  endpoint: { UnixSocket: "/private/run/source.sock" },
  transportReady: true,
  executionReady: false,
  source: {
    version: 1,
    targetId: "original-encrypted-account-target",
    instanceId: selection.nativeInstanceId,
    publicIdentity: "original-native-public-pin",
    accountEpoch: 7,
    peerId: "retained-native-peer",
    generation: 11,
    consumer: {
      ownerUserId: "original-owner",
      actorUserId: "original-actor",
      actorEpoch: 8,
      computerId: selection.computerId,
      computerRevision: "current-computer-revision",
      pairingId: "original-pairing",
      pairingRevision: "current-pairing-revision",
      deviceId: "original-device",
      proofKeyThumbprint: "original-proof-thumbprint",
    },
  },
};
const fixture = () => {
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    workjet: {
      ...DEFAULT_SERVER_SETTINGS.workjet,
      computers: [{
        id: selection.computerId,
        environmentId: selection.environmentId,
        label: "Registered fixture",
        presentationKind: "ssh",
        harnesses: [],
      }],
    },
  };
  let connections: ReadonlyArray<WorkjetConnectionSummary> = [{
    connectionId: selection.connectionId,
    instanceId: selection.instanceId,
    displayName: "Source fixture",
    source: "ctox_dev",
    status: "ready",
    reason: null,
  }];
  const bytes = new Map<string, Uint8Array>();
  let beforeCreate: (() => void) | undefined;
  const dependencies = {
    settings: { getSettings: Effect.sync(() => settings) },
    connections: {
      list: Effect.sync(() => connections),
      resolveReadyTarget: () => Effect.succeed({ endpoint: "http://127.0.0.1:8080/mcp", token: "fixture-only" }),
    },
    secrets: {
      get: (key: string) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(key))),
      create: (key: string, value: Uint8Array) => Effect.suspend(() => {
        beforeCreate?.();
        if (bytes.has(key)) return Effect.fail(new SecretStorePersistError({
          resource: "fixture",
          cause: { _tag: "PlatformError", reason: { _tag: "AlreadyExists" } },
        }));
        bytes.set(key, value);
        return Effect.void;
      }),
    },
  };
  return {
    make: makeNativeSupervisorSourceEnrollment(dependencies),
    bytes,
    settings: () => settings,
    setSettings: (value: ServerSettings) => { settings = value; },
    connections: () => connections,
    setConnections: (value: ReadonlyArray<WorkjetConnectionSummary>) => { connections = value; },
    beforeCreate: (value: () => void) => { beforeCreate = value; },
  };
};

it.effect("retains the original native account and runtime across service restart without storing IPC or authority", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    const plan = yield* service.prepare(selection, runtime);
    assert.equal(f.bytes.size, 0);
    yield* service.retainStarted(plan, {
      ...startup,
      capabilityToken: "untrusted-extra-field",
      source: { ...startup.source, credential: "untrusted-extra-field" },
    });
    assert.equal(f.bytes.size, 1);
    const json = new TextDecoder().decode([...f.bytes.values()][0]!);
    assert.ok(json.includes("original-encrypted-account-target"));
    assert.ok(json.includes(runtime.nativeRoot));
    for (const omitted of ["source.sock", "peerId", "generation", "computerRevision", "credential", "capabilityToken", "untrusted-extra-field"]) {
      assert.ok(!json.includes(omitted), omitted);
    }
    const restored = yield* (yield* f.make).resolve(selection);
    assert.deepEqual(restored.runtime, runtime);
    assert.deepEqual(yield* nativeSupervisorSourceArguments(restored, "/private/owned-run"), [
      "sync", "supervisor-source-selected", selection.nativeInstanceId,
      selection.computerId, "/private/owned-run", "--root", runtime.nativeRoot,
    ]);
    assert.notEqual(selection.instanceId, selection.nativeInstanceId);
    const current = yield* (yield* f.make).prepare(selection, runtime);
    const observed = yield* service.retainStarted(plan, {
      ...startup,
      source: { ...startup.source, generation: 12, peerId: "new-peer", consumer: {
        ...startup.source.consumer, computerRevision: "fresh-computer-revision",
        pairingRevision: "fresh-pairing-revision",
      } },
    });
    assert.equal(observed.source.generation, 12);
    assert.deepEqual(current.runtime, runtime);
  }),
);

it.effect("missing mapping stays unavailable without choosing a default account, binary or root", () =>
  Effect.gen(function* () {
    const f = fixture();
    const error = yield* Effect.flip((yield* f.make).resolve(selection));
    assert.equal(error.reason, "runtime-unconfigured");
    assert.equal(f.bytes.size, 0);
  }),
);

it.effect("rejects relative or malformed managed runtime and private IPC paths", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    for (const path of ["ctox", "relative/root", "/root\nother", "/root\0other"]) {
      const error = yield* Effect.flip(service.prepare(selection, { ...runtime, ctoxExecutable: path }));
      assert.equal(error.reason, "runtime-unconfigured");
      yield* Effect.flip(service.prepare(selection, { ...runtime, nativeRoot: path }));
    }
    const plan = yield* service.prepare(selection, runtime);
    yield* Effect.flip(nativeSupervisorSourceArguments(plan, "relative/ipc"));
    assert.equal(f.bytes.size, 0);
  }),
);

it.effect("requires one current registered computer and an exact ready source scope", () =>
  Effect.gen(function* () {
    for (const mode of ["absent", "duplicate", "wrong-environment", "wrong-instance", "offline", "duplicate-connection"]) {
      const f = fixture();
      if (mode === "absent") f.setSettings({ ...f.settings(), workjet: { ...f.settings().workjet, computers: [] } });
      if (mode === "duplicate") f.setSettings({ ...f.settings(), workjet: { ...f.settings().workjet, computers: [...f.settings().workjet.computers, ...f.settings().workjet.computers] } });
      if (mode === "wrong-environment") f.setSettings({ ...f.settings(), workjet: { ...f.settings().workjet, computers: [{ ...f.settings().workjet.computers[0]!, environmentId: EnvironmentId.make("foreign") }] } });
      if (mode === "wrong-instance") f.setConnections([{ ...f.connections()[0]!, instanceId: "foreign" }]);
      if (mode === "offline") f.setConnections([{ ...f.connections()[0]!, status: "offline" }]);
      if (mode === "duplicate-connection") f.setConnections([...f.connections(), ...f.connections()]);
      const error = yield* Effect.flip((yield* f.make).prepare(selection, runtime));
      assert.equal(error.reason, "selection-unavailable", mode);
      assert.equal(f.bytes.size, 0);
    }
  }),
);

it.effect("requires genuine selected startup facts before retaining a mapping", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    const plan = yield* service.prepare(selection, runtime);
    for (const invalid of [
      { ...startup, transportReady: false },
      { ...startup, executionReady: true },
      { ...startup, source: { ...startup.source, instanceId: selection.instanceId } },
      { ...startup, source: { ...startup.source, generation: -1 } },
      { ...startup, source: { ...startup.source, peerId: "" } },
      { ...startup, source: { ...startup.source, consumer: { ...startup.source.consumer, computerId: "foreign" } } },
    ]) {
      const error = yield* Effect.flip(service.retainStarted(plan, invalid));
      assert.equal(error.reason, "source-mismatch");
    }
    const error = yield* Effect.flip(service.retainStarted({ ...plan }, startup));
    assert.equal(error.reason, "source-mismatch");
    assert.equal(f.bytes.size, 0);
  }),
);

it.effect("cannot rebind an existing mapping to another root, binary or canonical account", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    yield* service.retainStarted(yield* service.prepare(selection, runtime), startup);
    const before = [...f.bytes.values()][0];
    for (const changed of [{ ...runtime, nativeRoot: "/other/root" }, { ...runtime, ctoxExecutable: "/other/ctox" }]) {
      assert.equal((yield* Effect.flip(service.prepare(selection, changed))).reason, "runtime-conflict");
    }
    assert.equal((yield* Effect.flip(service.prepare({ ...selection, nativeInstanceId: "foreign" }, runtime))).reason, "stored-mapping-invalid");
    assert.equal(f.bytes.size, 1);
    assert.deepEqual([...f.bytes.values()][0], before);
  }),
);

it.effect("a service restart rejects changed original enrollment and principal facts", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    yield* service.retainStarted(yield* service.prepare(selection, runtime), startup);
    const restarted = yield* f.make;
    const plan = yield* restarted.resolve(selection);
    const variants = [
      { ...startup.source, targetId: "replacement-encrypted-target" },
      { ...startup.source, publicIdentity: "replacement-pin" },
      { ...startup.source, accountEpoch: 9 },
      ...(["ownerUserId", "actorUserId", "pairingId", "deviceId", "proofKeyThumbprint"] as const)
        .map((field) => ({ ...startup.source, consumer: { ...startup.source.consumer, [field]: "replacement" } })),
      { ...startup.source, consumer: { ...startup.source.consumer, actorEpoch: 9 } },
    ];
    for (const source of variants) {
      assert.equal((yield* Effect.flip(restarted.retainStarted(plan, { ...startup, source }))).reason, "source-mismatch");
    }
    assert.equal(f.bytes.size, 1);
  }),
);

it.effect("a registry change while native startup is pending prevents publication", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    const plan = yield* service.prepare(selection, runtime);
    f.setConnections([{ ...f.connections()[0]!, status: "offline" }]);
    assert.equal((yield* Effect.flip(service.retainStarted(plan, startup))).reason, "selection-unavailable");
    assert.equal(f.bytes.size, 0);
  }),
);

it.effect("rechecks selection after durable creation and never treats an orphan mapping as usable", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    const plan = yield* service.prepare(selection, runtime);
    f.beforeCreate(() => f.setSettings({ ...f.settings(), workjet: { ...f.settings().workjet, computers: [] } }));
    assert.equal((yield* Effect.flip(service.retainStarted(plan, startup))).reason, "selection-unavailable");
    assert.equal((yield* Effect.flip((yield* f.make).resolve(selection))).reason, "selection-unavailable");
  }),
);

it.effect("concurrent first writers may only retain the same original identity", () =>
  Effect.gen(function* () {
    const f = fixture();
    const first = yield* f.make;
    const second = yield* f.make;
    const one = yield* first.prepare(selection, runtime);
    const two = yield* second.prepare(selection, runtime);
    yield* first.retainStarted(one, startup);
    yield* second.retainStarted(two, startup);
    assert.equal(f.bytes.size, 1);
    assert.equal((yield* Effect.flip(second.retainStarted(two, {
      ...startup, source: { ...startup.source, targetId: "foreign-target" },
    }))).reason, "source-mismatch");
  }),
);

it.effect("rejects corrupt protected storage without fabricating an enrollment", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    yield* service.retainStarted(yield* service.prepare(selection, runtime), startup);
    for (const key of f.bytes.keys()) f.bytes.set(key, new TextEncoder().encode("{}"));
    assert.equal((yield* Effect.flip((yield* f.make).resolve(selection))).reason, "stored-mapping-invalid");
    assert.equal(f.bytes.size, 1);
  }),
);
