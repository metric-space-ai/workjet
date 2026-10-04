import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type WorkjetSessionImportInput,
  type WorkjetSessionImportInspectInput,
} from "@workjet/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const environmentId = EnvironmentId.make("import-environment");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Isolated importer",
  httpBaseUrl: "https://import.example.test",
  wsBaseUrl: "wss://import.example.test",
});
const fixture = Effect.fn(function* (client: WsRpcProtocolClient) {
  const supervisor = EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
      Option.some({
        client,
        initialConfig: Effect.die("config is unused"),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      }),
    ),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const connectionRegistry = {
    run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
  } as unknown as EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, connectionRegistry),
  ) as unknown as Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore, never>;
  const server = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(null),
  });
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
    (value) => Effect.sync(() => value.dispose()),
  );
  return { server, registry };
});
describe("session importer request correlation", () => {
  it.effect(
    "executes a newer selection separately while an old page is pending in the same environment",
    () =>
      Effect.gen(function* () {
        const started = Latch.makeUnsafe();
        const release = Latch.makeUnsafe();
        const received: number[] = [];
        const client = {
          [WS_METHODS.workjetSessionImportInspect]: (input: WorkjetSessionImportInspectInput) =>
            Effect.gen(function* () {
              received.push(input.offset ?? 0);
              if (input.offset === 0) {
                started.openUnsafe();
                yield* release.await;
              }
              return {
                sources: [],
                candidates: [],
                truncated: false,
                nextOffset: input.offset,
                discoveryVersion: "a".repeat(64),
              };
            }),
        } as unknown as WsRpcProtocolClient;
        const { server, registry } = yield* fixture(client);
        try {
          const first = server.inspectWorkjetSessions.run(registry, {
            environmentId,
            input: { query: "old", offset: 0 },
          });
          yield* started.await;
          const second = server.inspectWorkjetSessions.run(registry, {
            environmentId,
            input: { query: "new", offset: 100 },
          });
          expect(received).toEqual([0]);
          release.openUnsafe();
          expect(yield* Effect.promise(() => first)).toMatchObject({
            _tag: "Success",
            value: { nextOffset: 0 },
          });
          expect(yield* Effect.promise(() => second)).toMatchObject({
            _tag: "Success",
            value: { nextOffset: 100 },
          });
          expect(received).toEqual([0, 100]);
        } finally {
          release.openUnsafe();
        }
      }),
  );
  it.effect(
    "keeps candidate batches and target projects distinct while an earlier import is pending",
    () =>
      Effect.gen(function* () {
        const started = Latch.makeUnsafe();
        const release = Latch.makeUnsafe();
        const received: WorkjetSessionImportInput[] = [];
        const firstId = "wjsi_" + "a".repeat(32);
        const secondId = "wjsi_" + "b".repeat(32);
        const firstProject = ProjectId.make("first-project");
        const secondProject = ProjectId.make("second-project");
        const client = {
          [WS_METHODS.workjetSessionImport]: (input: WorkjetSessionImportInput) =>
            Effect.gen(function* () {
              received.push(input);
              if (input.projectId === firstProject) {
                started.openUnsafe();
                yield* release.await;
              }
              return {
                items: [
                  {
                    candidateId: input.candidateIds[0]!,
                    status: "imported" as const,
                    threadId: ThreadId.make(`copy-${input.projectId}`),
                    importedMessages: 1,
                    totalMessages: 1,
                    message: "Copied",
                  },
                ],
              };
            }),
        } as unknown as WsRpcProtocolClient;
        const { server, registry } = yield* fixture(client);
        try {
          const first = server.importWorkjetSessions.run(registry, {
            environmentId,
            input: { projectId: firstProject, candidateIds: [firstId] },
          });
          yield* started.await;
          const second = server.importWorkjetSessions.run(registry, {
            environmentId,
            input: { projectId: secondProject, candidateIds: [secondId] },
          });
          expect(received).toHaveLength(1);
          release.openUnsafe();
          expect(yield* Effect.promise(() => first)).toMatchObject({
            _tag: "Success",
            value: { items: [{ candidateId: firstId, threadId: "copy-first-project" }] },
          });
          expect(yield* Effect.promise(() => second)).toMatchObject({
            _tag: "Success",
            value: { items: [{ candidateId: secondId, threadId: "copy-second-project" }] },
          });
          expect(received).toEqual([
            { projectId: firstProject, candidateIds: [firstId] },
            { projectId: secondProject, candidateIds: [secondId] },
          ]);
        } finally {
          release.openUnsafe();
        }
      }),
  );
});
