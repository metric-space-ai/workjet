import { expect, it } from "@effect/vitest";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  WorkjetConnectionId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "./auth/ServerSecretStore.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { CtoxThreadBindingSourceLayerLive } from "./server.ts";
import { CtoxThreadBindingSource } from "./workjet/ctox/CtoxThreadBinding.ts";

const environmentId = EnvironmentId.make("source-environment");
const connectionId = WorkjetConnectionId.make("source-connection");
const instanceId = "source-instance";
const config = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  schemaVersion: 2,
  enabledCapabilityIds: ["ctox-business-os"],
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os",
      target: { kind: "ctox-connection", connectionId, instanceId },
    },
  ],
} satisfies WorkjetThreadConfig;

it.effect("the production native binding layer follows registry changes after construction", () =>
  Effect.gen(function* () {
    const bindings = yield* CtoxThreadBindingSource;
    const sql = yield* SqlClient.SqlClient;
    expect(yield* bindings.fromStartConfig(config)).toEqual({ environmentId, binding: undefined });

    yield* sql`
      INSERT INTO workjet_decision_hub_connections
        (connection_id, instance_id, display_name, source, status, created_at_ms, updated_at_ms)
      VALUES (${connectionId}, ${instanceId}, 'Acceptance source', 'ctox_dev', 'ready', 0, 0)
    `;
    expect(yield* bindings.fromStartConfig(config)).toEqual({
      environmentId,
      binding: { connectionId, instanceId },
    });

    yield* sql`
      UPDATE workjet_decision_hub_connections SET status = 'offline'
      WHERE connection_id = ${connectionId}
    `;
    expect(yield* bindings.fromStartConfig(config)).toEqual({ environmentId, binding: undefined });

    yield* sql`
      UPDATE workjet_decision_hub_connections SET status = 'ready', instance_id = 'other-instance'
      WHERE connection_id = ${connectionId}
    `;
    expect(yield* bindings.fromStartConfig(config)).toEqual({ environmentId, binding: undefined });
  }).pipe(
    Effect.provide(CtoxThreadBindingSourceLayerLive),
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("No environment descriptor is needed to resolve a binding"),
    }),
    Effect.provideService(ServerSecretStore, {
      get: () => Effect.die("Binding discovery must not read credentials"),
      set: () => Effect.die("Binding discovery must not write credentials"),
      remove: () => Effect.die("Binding discovery must not remove credentials"),
      create: () => Effect.die("Binding discovery must not create credentials"),
      getOrCreateRandom: () => Effect.die("Binding discovery must not create credentials"),
    }),
    Effect.provide(SqlitePersistenceMemory),
  ),
);
