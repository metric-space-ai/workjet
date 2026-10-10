// @effect-diagnostics nodeBuiltinImport:off -- Isolated service-scope fixtures; no native/SDK authority or installed acceptance.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, WorkjetComputerId, WorkjetConnectionId } from "@workjet/contracts";
import * as Option from "effect/Option";
import { makeNativeSupervisorSourceEnrollment } from "./NativeSupervisorSourceEnrollment.ts";
import { afterEach, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import {
  acquireNativeSupervisorSourceTransport,
  type NativeSupervisorSourceTransport,
} from "./NativeSupervisorSourceTransport.ts";
import { runNextNativeSupervisorSdkTurn } from "./NativeSupervisorSdkExecutor.ts";
import { openSelectedNativeSupervisorSdkSourceService } from "./NativeSupervisorSdkSourceService.ts";

vi.mock("./NativeSupervisorSourceTransport.ts", async (actual) => {
  const module = await actual<typeof import("./NativeSupervisorSourceTransport.ts")>();
  return { ...module, acquireNativeSupervisorSourceTransport: vi.fn() };
});
vi.mock("./NativeSupervisorSdkExecutor.ts", () => ({ runNextNativeSupervisorSdkTurn: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
});
function fixture() {
  const events: string[] = [];
  const source: NativeSupervisorSourceTransport = {
    processId: process.pid,
    endpoint: "/isolated-scope-fixture",
    startup: {
      protocolVersion: 1,
      endpoint: "/isolated-scope-fixture",
      transportReady: true,
      executionReady: false,
    },
    executionReady: false,
    request: async () => null,
    close: async () => {
      events.push("original-source-close");
      return { exitCode: 0, signal: null };
    },
  };
  vi.mocked(acquireNativeSupervisorSourceTransport).mockImplementation(() =>
    Effect.acquireRelease(Effect.succeed(source), (original) =>
      Effect.promise(() => original.close()),
    ),
  );
  const selection = {
    environmentId: EnvironmentId.make("fixture-environment"),
    computerId: WorkjetComputerId.make("fixture-computer"),
    connectionId: WorkjetConnectionId.make("fixture-connection"),
    instanceId: "fixture-managed-instance",
    nativeInstanceId: "fixture-native-instance",
  };
  const plan = {
    selection,
    runtime: { ctoxExecutable: "/fixture/protected/ctox", nativeRoot: "/fixture/original-root" },
  };
  const enrollment = {
    prepare: () => Effect.succeed(plan),
    resolve: vi.fn(() => Effect.succeed(plan)),
    retainStarted: vi.fn(() =>
      Effect.succeed({
        protocolVersion: 1 as const,
        transportReady: true as const,
        executionReady: false as const,
        source: {
          version: 1 as const,
          targetId: "fixture-target",
          instanceId: selection.nativeInstanceId,
          publicIdentity: "fixture-public",
          accountEpoch: 1,
          peerId: "fixture-peer",
          generation: 1,
          consumer: {
            ownerUserId: "fixture-owner",
            actorUserId: "fixture-owner",
            actorEpoch: 1,
            computerId: selection.computerId,
            pairingId: "fixture-pair",
            deviceId: "fixture-device",
            proofKeyThumbprint: "fixture-proof",
            computerRevision: "fixture-computer-rev",
            pairingRevision: "fixture-pair-rev",
          },
        },
      }),
    ),
  };
  return { source, events, plan, enrollment, selection };
}
it.effect(
  "resolves, starts and retains the same selected original Source before running the SDK",
  () =>
    Effect.gen(function* () {
      const fixtureValue = fixture();
      vi.mocked(runNextNativeSupervisorSdkTurn).mockResolvedValueOnce(null);
      const service = yield* openSelectedNativeSupervisorSdkSourceService({
        enrollment: fixtureValue.enrollment,
        selection: fixtureValue.selection,
        privateServiceDirectory: "/isolated-fixture/service",
        sdkExecutable: "/fixture/sdk.js",
      });
      expect(fixtureValue.enrollment.retainStarted).toHaveBeenCalledWith(
        fixtureValue.plan,
        fixtureValue.source.startup,
      );
      expect(yield* service.runNext()).toBeNull();
      expect(vi.mocked(runNextNativeSupervisorSdkTurn).mock.calls[0]?.[0].source).toBe(
        fixtureValue.source,
      );
      expect(acquireNativeSupervisorSourceTransport).toHaveBeenCalledWith({
        executable: "/fixture/protected/ctox",
        originalNativeRoot: "/fixture/original-root",
        ipcDirectory: "/isolated-fixture/service/source",
        selected: { instanceId: "fixture-native-instance", computerId: "fixture-computer" },
      });
    }).pipe(Effect.scoped),
);
it.effect("retains a caller-interrupted query and joins it before the Source finalizer", () =>
  Effect.gen(function* () {
    const fixtureValue = fixture();
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const ownerAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runNextNativeSupervisorSdkTurn).mockImplementationOnce(async ({ serviceSignal }) => {
      started();
      serviceSignal.addEventListener(
        "abort",
        () => {
          fixtureValue.events.push("sdk-owner-abort");
          aborted();
        },
        { once: true },
      );
      await drained;
      fixtureValue.events.push("sdk-fixture-drain");
      return null;
    });
    const scope = yield* Scope.make();
    const service = yield* openSelectedNativeSupervisorSdkSourceService({
      enrollment: fixtureValue.enrollment,
      selection: fixtureValue.selection,
      privateServiceDirectory: "/isolated-fixture/service",
      sdkExecutable: "/fixture/sdk.js",
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const caller = yield* service.runNext().pipe(Effect.forkChild);
    yield* Effect.promise(() => start);
    yield* Fiber.interrupt(caller);
    const duplicate = yield* service.runNext().pipe(Effect.flip);
    expect(duplicate.reason).toBe("turn-active");
    const closing = yield* Scope.close(scope, Exit.succeed(undefined)).pipe(Effect.forkChild);
    yield* Effect.promise(() => ownerAborted);
    expect(fixtureValue.events).toEqual(["sdk-owner-abort"]);
    release();
    yield* Fiber.join(closing);
    expect(fixtureValue.events).toEqual([
      "sdk-owner-abort",
      "sdk-fixture-drain",
      "original-source-close",
    ]);
  }).pipe(Effect.scoped),
);

function freshEnrollmentFixture() {
  const f = fixture();
  const bytes = new Map<string, Uint8Array>();
  let ready = true;
  const startup = {
    ...f.source.startup,
    source: {
      version: 1 as const,
      targetId: "fixture-target",
      instanceId: f.selection.nativeInstanceId,
      publicIdentity: "fixture-public",
      accountEpoch: 1,
      peerId: "fixture-peer",
      generation: 1,
      consumer: {
        ownerUserId: "fixture-owner",
        actorUserId: "fixture-owner",
        actorEpoch: 1,
        computerId: f.selection.computerId,
        pairingId: "fixture-pair",
        deviceId: "fixture-device",
        proofKeyThumbprint: "fixture-proof",
        computerRevision: "fixture-computer-rev",
        pairingRevision: "fixture-pair-rev",
      },
    },
  };
  const source: NativeSupervisorSourceTransport = { ...f.source, startup };
  vi.mocked(acquireNativeSupervisorSourceTransport).mockImplementation(() =>
    Effect.acquireRelease(Effect.succeed(source), (original) =>
      Effect.promise(() => original.close()),
    ),
  );
  const makeEnrollment = makeNativeSupervisorSourceEnrollment({
    settings: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        workjet: {
          ...DEFAULT_SERVER_SETTINGS.workjet,
          computers: [{
            id: f.selection.computerId,
            environmentId: f.selection.environmentId,
            label: "Fixture computer",
            presentationKind: "ssh" as const,
            harnesses: [],
          }],
        },
      }),
    },
    connections: {
      list: Effect.sync(() => [{
        connectionId: f.selection.connectionId,
        instanceId: f.selection.instanceId,
        displayName: "Fixture Source",
        source: "ctox_dev" as const,
        status: ready ? "ready" as const : "needs_auth" as const,
        reason: null,
      }]),
      resolveReadyTarget: () => Effect.succeed({ endpoint: "https://fixture.invalid/mcp", token: "fixture-only" }),
    },
    secrets: {
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(key))),
      create: (key, value) => Effect.sync(() => { bytes.set(key, value); }),
    },
  });
  return { ...f, source, makeEnrollment, bytes, setReady: (value: boolean) => { ready = value; } };
}

it.effect("first start retains the actual Source identity, then restart resolves it without runtime input", () =>
  Effect.gen(function* () {
    const f = freshEnrollmentFixture();
    const enrollment = yield* f.makeEnrollment;
    expect((yield* enrollment.resolve(f.selection).pipe(Effect.flip)).reason).toBe("runtime-unconfigured");
    expect(f.bytes.size).toBe(0);
    vi.mocked(runNextNativeSupervisorSdkTurn).mockImplementation(async () => {
      expect(f.bytes.size).toBe(1);
      return null;
    });
    yield* Effect.gen(function* () {
      const service = yield* openSelectedNativeSupervisorSdkSourceService({
        enrollment,
        selection: f.selection,
        managedRuntime: f.plan.runtime,
        privateServiceDirectory: "/isolated-fixture/service",
        sdkExecutable: "/fixture/sdk.js",
      });
      expect(f.bytes.size).toBe(1);
      expect(acquireNativeSupervisorSourceTransport).toHaveBeenCalledTimes(1);
      expect(yield* service.runNext()).toBeNull();
    }).pipe(Effect.scoped);
    const saved = [...f.bytes.values()][0]!;
    const restarted = yield* f.makeEnrollment;
    yield* Effect.gen(function* () {
      const service = yield* openSelectedNativeSupervisorSdkSourceService({
        enrollment: restarted,
        selection: f.selection,
        privateServiceDirectory: "/isolated-fixture/service",
        sdkExecutable: "/fixture/sdk.js",
      });
      expect(yield* service.runNext()).toBeNull();
    }).pipe(Effect.scoped);
    expect(acquireNativeSupervisorSourceTransport).toHaveBeenCalledTimes(2);
    expect([...f.bytes.values()][0]).toEqual(saved);
    expect(f.events).toEqual(["original-source-close", "original-source-close"]);
  }),
);

it.effect("a first-start selection that needs authorization cannot spawn a Source or SDK", () =>
  Effect.gen(function* () {
    const f = freshEnrollmentFixture();
    f.setReady(false);
    const enrollment = yield* f.makeEnrollment;
    const error = yield* openSelectedNativeSupervisorSdkSourceService({
      enrollment,
      selection: f.selection,
      managedRuntime: f.plan.runtime,
      privateServiceDirectory: "/isolated-fixture/service",
      sdkExecutable: "/fixture/sdk.js",
    }).pipe(Effect.scoped, Effect.flip);
    expect(error.reason).toBe("selection-unavailable");
    expect(acquireNativeSupervisorSourceTransport).not.toHaveBeenCalled();
    expect(runNextNativeSupervisorSdkTurn).not.toHaveBeenCalled();
    expect(f.bytes.size).toBe(0);
  }),
);

it.effect("a conflicting first-start runtime cannot replace a retained original mapping", () =>
  Effect.gen(function* () {
    const f = freshEnrollmentFixture();
    const enrollment = yield* f.makeEnrollment;
    yield* openSelectedNativeSupervisorSdkSourceService({
      enrollment,
      selection: f.selection,
      managedRuntime: f.plan.runtime,
      privateServiceDirectory: "/isolated-fixture/service",
      sdkExecutable: "/fixture/sdk.js",
    }).pipe(Effect.scoped);
    const saved = [...f.bytes.values()][0]!;
    vi.mocked(acquireNativeSupervisorSourceTransport).mockClear();
    const error = yield* openSelectedNativeSupervisorSdkSourceService({
      enrollment,
      selection: f.selection,
      managedRuntime: { ...f.plan.runtime, nativeRoot: "/another-root" },
      privateServiceDirectory: "/isolated-fixture/service",
      sdkExecutable: "/fixture/sdk.js",
    }).pipe(Effect.scoped, Effect.flip);
    expect(error.reason).toBe("runtime-conflict");
    expect(acquireNativeSupervisorSourceTransport).not.toHaveBeenCalled();
    expect(runNextNativeSupervisorSdkTurn).not.toHaveBeenCalled();
    expect([...f.bytes.values()][0]).toEqual(saved);
  }),
);

it.effect("a first-start native identity mismatch closes only its owned Source and never starts the SDK", () =>
  Effect.gen(function* () {
    const f = freshEnrollmentFixture();
    const foreign: NativeSupervisorSourceTransport = {
      ...f.source,
      startup: { ...f.source.startup, source: { ...f.source.startup.source!, instanceId: "foreign-native-instance" } },
    };
    vi.mocked(acquireNativeSupervisorSourceTransport).mockImplementation(() =>
      Effect.acquireRelease(Effect.succeed(foreign), (original) => Effect.promise(() => original.close())),
    );
    const enrollment = yield* f.makeEnrollment;
    const error = yield* openSelectedNativeSupervisorSdkSourceService({
      enrollment,
      selection: f.selection,
      managedRuntime: f.plan.runtime,
      privateServiceDirectory: "/isolated-fixture/service",
      sdkExecutable: "/fixture/sdk.js",
    }).pipe(Effect.scoped, Effect.flip);
    expect(error.reason).toBe("source-mismatch");
    expect(f.bytes.size).toBe(0);
    expect(runNextNativeSupervisorSdkTurn).not.toHaveBeenCalled();
    expect(f.events).toEqual(["original-source-close"]);
  }),
);
