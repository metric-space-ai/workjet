// @effect-diagnostics nodeBuiltinImport:off -- Isolated service-scope fixtures; no native/SDK authority or installed acceptance.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { EnvironmentId, WorkjetComputerId, WorkjetConnectionId } from "@workjet/contracts";
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
