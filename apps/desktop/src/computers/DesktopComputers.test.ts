// @effect-diagnostics nodeBuiltinImport:off -- Native services are provided; the connection/session ports are isolated fakes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  WorkjetConfiguration,
  WorkjetComputerId,
  EnvironmentId,
  WS_METHODS,
  type CtoxWorkjetComputerControlRequest,
  type CtoxWorkjetComputerControlResult,
} from "@workjet/contracts";
import type { RpcSession } from "@workjet/client-runtime/rpc";
import { DesktopBackendPool } from "../backend/DesktopBackendPool.ts";
import { DesktopLocalServiceSession } from "../backend/DesktopLocalServiceSession.ts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { CtoxGuestManager } from "../ctox/CtoxGuestManager.ts";
import { make } from "./DesktopComputers.ts";
import { defaultComputerMetadata } from "./computerRegistry.ts";
const decodeComputerConfiguration = Schema.decodeUnknownEffect(WorkjetConfiguration);
const facts = {
  checkedAt: "2026-10-11T00:00:00Z",
  machineId: "fixture-machine",
  operatingSystem: "Linux",
  architecture: "x86_64",
  cpuCores: 8,
  ramBytes: 1,
  homeDirectory: "/home/fixture",
  workDirectory: "/home/fixture/.workjet/computer-work",
  freeBytes: 100000000000,
  gpus: [],
  toolchains: {},
  codingTools: {},
  warnings: [],
};
const fixture = Effect.gen(function* () {
  const computer = {
    id: WorkjetComputerId.make("fixture-computer"),
    environmentId: EnvironmentId.make("fixture-environment"),
    label: "Fixture",
    presentationKind: "ssh" as const,
    harnesses: [],
    metadata: {
      ...defaultComputerMetadata({
        _tag: "ssh",
        target: { alias: "fixture", hostname: "fixture", username: null, port: null },
      }),
      facts,
    },
  };
  const configuration = yield* decodeComputerConfiguration({ computers: [computer] });
  const state = yield* Ref.make(configuration);
  const writes = yield* Ref.make(0);
  const requests = yield* Ref.make<readonly CtoxWorkjetComputerControlRequest[]>([]);
  const supportsDetected = yield* Ref.make(true);
  const wrongActive = yield* Ref.make(false);
  const session = {
    ready: Effect.void,
    client: {
      [WS_METHODS.serverGetSettings]: () =>
        Ref.get(state).pipe(Effect.map((workjet) => ({ workjet }))),
      [WS_METHODS.serverUpdateSettings]: ({
        patch,
      }: {
        patch: { workjet: WorkjetConfiguration };
      }) =>
        Ref.set(state, patch.workjet).pipe(
          Effect.andThen(Ref.update(writes, (count) => count + 1)),
          Effect.as({ workjet: patch.workjet }),
        ),
    },
  } as unknown as RpcSession;
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(DesktopBackendPool, {
      primary: Effect.succeed({ currentConfig: Effect.succeed(Option.some({})) }),
    } as DesktopBackendPool["Service"]),
    Layer.succeed(DesktopLocalServiceSession, {
      attach: () => Effect.succeed(session),
      get: () => Effect.succeed("fixture-session"),
    } as DesktopLocalServiceSession["Service"]),
    Layer.succeed(DesktopEnvironment, {
      homeDirectory: "/unused-test-home",
    } as DesktopEnvironment["Service"]),
    Layer.succeed(CtoxGuestManager, {
      requestComputerControl: (_instance: string, request: CtoxWorkjetComputerControlRequest) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (current) => [...current, request]);
          if (request.action !== "computer.assign")
            return { _tag: "failed", code: "unsupported" } as const;
          const support = yield* Ref.get(supportsDetected);
          const mismatch = yield* Ref.get(wrongActive);
          const response: CtoxWorkjetComputerControlResult = {
            _tag: "completed",
            response: {
              action: "computer.assign",
              computer: {
                id: request.computerId,
                displayName: request.displayName,
                hostingMode: request.hostingMode,
                status: "assigned",
                capabilities: request.capabilities,
                selfHostedColocation: false,
                ...(support
                  ? {
                      active: mismatch ? !request.active : request.active,
                      roles: request.roles,
                      detectedFacts: request.detectedFacts,
                      hostKeyFingerprint: request.hostKeyFingerprint,
                    }
                  : {}),
              },
            },
          };
          return response;
        }),
    } as CtoxGuestManager["Service"]),
  );
  const service = yield* make.pipe(Effect.provide(dependencies));
  return { service, state, writes, requests, supportsDetected, wrongActive, computer };
});
it.effect(
  "lists without writes and persists activation and roles through the existing settings session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        yield* test.service.control({ _tag: "list" });
        expect(yield* Ref.get(test.writes)).toBe(0);
        yield* test.service.control({ _tag: "setActive", id: test.computer.id, active: false });
        const result = yield* test.service.control({
          _tag: "setRoles",
          id: test.computer.id,
          roles: { build: false, storage: true },
        });
        expect(result.computers[0]?.metadata).toMatchObject({
          active: false,
          roles: { build: false, storage: true },
          facts,
        });
        expect(yield* Ref.get(test.writes)).toBe(2);
      }),
    ),
);
it.effect("removes only the computer record without invoking remote cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const result = yield* test.service.control({
        _tag: "remove",
        id: test.computer.id,
        mode: "workjet-only",
      });
      expect(result.computers).toEqual([]);
      expect(result.removedPaths).toEqual([]);
      expect(yield* Ref.get(test.requests)).toEqual([]);
    }),
  ),
);
it.effect(
  "keeps legacy native assignments valid and marks their locally retained facts unconfirmed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        yield* test.service.control({ _tag: "setActive", id: test.computer.id, active: false });
        expect((yield* test.service.assign(test.computer.id, "fixture-instance"))._tag).toBe(
          "completed",
        );
        expect((yield* Ref.get(test.requests))[0]).toMatchObject({
          active: false,
          roles: { build: true, storage: false },
          detectedFacts: facts,
        });
        expect((yield* Ref.get(test.requests))[0]).not.toHaveProperty("capabilityConfig");
        expect((yield* Ref.get(test.state)).computers[0]?.metadata?.assignment).toEqual({
          instanceId: "fixture-instance",
          confirmation: "confirmed",
        });
        yield* Ref.set(test.supportsDetected, false);
        expect((yield* test.service.assign(test.computer.id, "legacy-instance"))._tag).toBe(
          "completed",
        );
        const listed = yield* test.service.control({ _tag: "list" });
        expect(listed.computers[0]?.metadata).toMatchObject({
          status: "unverified",
          active: false,
          roles: { build: true, storage: false },
          facts,
          assignment: { instanceId: "legacy-instance", confirmation: "unverified" },
        });
      }),
    ),
);

it.effect("rejects conflicting values from native instances that support detected fields", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Ref.set(test.wrongActive, true);
      expect(yield* test.service.assign(test.computer.id, "fixture-instance")).toEqual({
        _tag: "failed",
        code: "unsupported",
      });
      expect(yield* Ref.get(test.writes)).toBe(0);
    }),
  ),
);
