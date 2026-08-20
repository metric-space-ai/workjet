// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import { EnvironmentId, WorkjetMeshWorkspaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { WorkjetMailboxAuditEventInput } from "./WorkjetMailboxAuditEmitter.ts";
import {
  WorkjetMailboxStore,
  WorkjetMailboxStoreLive,
  isWorkjetMailboxError,
  type WorkjetMailboxStoreShape,
} from "./WorkjetMailboxStore.ts";
import { revokeMeshPeer } from "./WorkjetMeshRevocationRpc.ts";

const WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const PEER = EnvironmentId.make("environment-peer");

const testLayer = Layer.mergeAll(
  WorkjetMailboxStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

const capturing = () => {
  const events: Array<WorkjetMailboxAuditEventInput> = [];
  return {
    events,
    sink: {
      emit: (event: WorkjetMailboxAuditEventInput) => {
        events.push(event);
        return Effect.void;
      },
    },
  };
};

const pinPeer = (environmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO workjet_mailbox_peer_keys
        (source_workspace_id, source_environment_id, public_key, encryption_public_key,
         first_seen_at_ms, key_binding)
      VALUES (${WORKSPACE}, ${environmentId}, ${"signing-key"}, ${"encryption-key"},
              1000, 'self-signed')
    `;
  });

it.effect("destroys the pin and audits the revocation", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const captured = capturing();
    yield* pinPeer(PEER);

    const result = yield* revokeMeshPeer({
      store,
      peer: { schemaVersion: 1, workspaceId: WORKSPACE, environmentId: PEER },
      audit: captured.sink,
    });

    assert.deepEqual(result, { schemaVersion: 1, outcome: "revoked" });
    assert.strictEqual((yield* store.listMeshPeers(10)).peers.length, 0);

    // A revocation the operator did not perform must be VISIBLE, not silent —
    // it is the one mesh-trust write, and the audit trail is what makes an
    // unexpected one noticeable at all.
    assert.strictEqual(captured.events.length, 1);
    assert.deepInclude(captured.events[0], {
      _tag: "mesh-peer-revoked",
      sourceWorkspaceId: WORKSPACE,
      sourceEnvironmentId: PEER,
    });
    // Redaction, like every other mailbox audit event: ids only.
    const serialized = JSON.stringify(captured.events);
    assert.notInclude(serialized, "signing-key");
    assert.notInclude(serialized, "encryption-key");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("never audits a revocation that destroyed nothing", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const captured = capturing();

    const result = yield* revokeMeshPeer({
      store,
      peer: {
        schemaVersion: 1,
        workspaceId: WORKSPACE,
        environmentId: EnvironmentId.make("environment-typo"),
      },
      audit: captured.sink,
    });

    assert.deepEqual(result, { schemaVersion: 1, outcome: "unknown-peer" });
    // An audited "revoked" for an address that was never pinned would teach an
    // operator to ignore the event that matters.
    assert.deepEqual(captured.events, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("collapses a store outage into the bounded mailbox-unavailable failure", () =>
  Effect.gen(function* () {
    const captured = capturing();
    const broken = {
      revokeMeshPeer: () => Effect.die(new Error("disk on fire: /Users/someone/state.sqlite")),
    } as unknown as WorkjetMailboxStoreShape;

    const exit = yield* revokeMeshPeer({
      store: broken,
      peer: { schemaVersion: 1, workspaceId: WORKSPACE, environmentId: PEER },
      audit: captured.sink,
    }).pipe(Effect.sandbox, Effect.result);

    // The cause never reaches the client, and a failed revocation is never
    // audited as a completed one.
    assert.strictEqual(exit._tag, "Failure");
    assert.deepEqual(captured.events, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("maps a typed store failure onto mailbox-unavailable", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const sql = yield* SqlClient.SqlClient;
    yield* pinPeer(PEER);
    // Remove the table the revocation writes its tombstone into, so the
    // transaction fails for a reason the client must never see.
    yield* sql`DROP TABLE workjet_mailbox_peer_revocations`;

    const exit = yield* revokeMeshPeer({
      store,
      peer: { schemaVersion: 1, workspaceId: WORKSPACE, environmentId: PEER },
    }).pipe(Effect.result);

    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.isTrue(isWorkjetMailboxError(exit.failure));
      assert.strictEqual(
        isWorkjetMailboxError(exit.failure) ? exit.failure.reason : null,
        "mailbox-unavailable",
      );
    }

    // And the pin SURVIVES: a half-applied revocation that deleted the pin
    // without tombstoning the key would hand the revoked key a re-pin window.
    assert.strictEqual((yield* store.listMeshPeers(10)).peers.length, 1);
  }).pipe(Effect.provide(testLayer)),
);
