// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * `workjet.mesh.revokePeer` — the operator recovery path out of a refused key
 * rotation (docs/workjet-plan.md → "Authenticate remote worker dispatch […] and
 * revocable environment credentials", and the key-ROTATION gap on the Wave 5
 * replication line).
 *
 * WHAT IT FIXES. Peer identity is trust-on-first-use: the first envelope that
 * verifies pins `(workspaceId, environmentId) → both public keys` and every
 * later different key is refused. Against an impersonator that is exactly
 * right. Against a peer that legitimately rotated — reinstalled, restored from
 * backup, or rotated a key the operator believes was exposed — it is a dead
 * end: `signing-key-conflict` forever, with no way back. This RPC is the way
 * back, and it is the ONLY mesh-trust write this server exposes.
 *
 * WHY REVOCATION IS NOT ITSELF THE ATTACK. Read this before widening anything
 * here. Destroying a pin is precisely what an impersonator wants: revoke, then
 * win the re-pin race with a key of its own. Four properties, together, are why
 * that path is closed:
 *
 *  1. IT IS NOT ON THE WIRE. Nothing a peer can send reaches this function.
 *     There is no revocation envelope kind, no payload field that triggers one,
 *     and no CTOX daemon loopback route that does — the daemon's surface is
 *     publish / pending / consumed over opaque blobs. A room member who holds
 *     the room secret and can write the replicated collection still has no
 *     reach into this server's authenticated RPC socket.
 *  2. IT REQUIRES `orchestration:operate`. The scope table
 *     (`apps/server/src/auth/RpcAuthorization.ts`) gives this method the same
 *     scope that starts turns and writes provider credentials — never the
 *     roster's read scope. A read-only session cannot revoke. Neither can a
 *     WORKER thread or any MCP tool: this is not exposed as one, and the
 *     mailbox MCP tools are orchestrator-gated regardless.
 *  3. THE AUTHORITY IT NEEDS ALREADY EXCEEDS WHAT IT GRANTS. A caller holding
 *     an `orchestration:operate` credential on this machine can start turns on
 *     local threads directly; it does not need to impersonate a mesh peer to
 *     get work executed here. So revocation hands such a caller no authority it
 *     did not already have — which is the property that makes exposing it safe,
 *     rather than any assumption about the operator being careful.
 *  4. IT IS AUDITED AND CONFIRMED. Every revocation emits `mesh-peer-revoked`
 *     onto the redacted audit stream, and the UI requires an explicit
 *     typed-consequence confirmation, so a revocation the operator did not
 *     intend is neither silent nor one click away.
 *
 * AND THE RE-PIN WINDOW IS NARROWER THAN "ANY KEY". Revocation tombstones the
 * destroyed keys (migration 053). The address becomes re-pinnable, but the
 * REVOKED keys never do: whoever holds the old key cannot restore the pin the
 * operator just destroyed. The window this opens is the same trust-on-first-use
 * window the address had before its first contact, deliberately reopened.
 */
import {
  WorkjetMailboxError,
  type EnvironmentId,
  type WorkjetMeshRevokePeerInput,
  type WorkjetMeshRevokePeerResult,
  type WorkjetMeshWorkspaceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { emitAudit, type WorkjetMailboxAuditSink } from "./WorkjetMailboxAuditEmitter.ts";
import type { WorkjetMailboxStore } from "./WorkjetMailboxStore.ts";

/**
 * Revoke one peer's pinned keys.
 *
 * The store does the destroying in a single transaction (tombstone, then
 * delete). This function owns only the two things around it: the clock reading
 * that timestamps the tombstone, and the audit emission — which happens AFTER
 * the durable write and only for a revocation that really destroyed a pin, so
 * the stream never reports a revocation that did not happen.
 *
 * A store failure collapses to the bounded `mailbox-unavailable` every other
 * mailbox RPC uses; the cause never reaches the client.
 */
export const revokeMeshPeer = Effect.fn("WorkjetMeshRevocationRpc.revokeMeshPeer")(
  function* (input: {
    /**
     * The store is passed in rather than pulled from the context, because the
     * WS RPC layer resolves its Workjet services once and hands them to every
     * handler as values; requiring one here would leak into the layer's
     * requirements channel.
     */
    readonly store: WorkjetMailboxStore["Service"];
    readonly peer: WorkjetMeshRevokePeerInput;
    readonly audit?: WorkjetMailboxAuditSink | undefined;
  }) {
    const nowMillis = yield* Clock.currentTimeMillis;

    const outcome = yield* input.store
      .revokeMeshPeer(
        {
          workspaceId: input.peer.workspaceId satisfies WorkjetMeshWorkspaceId,
          environmentId: input.peer.environmentId satisfies EnvironmentId,
        },
        nowMillis,
      )
      .pipe(Effect.mapError(() => new WorkjetMailboxError({ reason: "mailbox-unavailable" })));

    if (outcome === "revoked") {
      yield* emitAudit(input.audit, {
        _tag: "mesh-peer-revoked",
        occurredAt: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
        sourceWorkspaceId: input.peer.workspaceId,
        sourceEnvironmentId: input.peer.environmentId,
      });
    }

    return { schemaVersion: 1, outcome } satisfies WorkjetMeshRevokePeerResult;
  },
);
