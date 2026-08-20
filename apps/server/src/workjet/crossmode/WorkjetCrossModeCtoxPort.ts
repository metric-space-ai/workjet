import {
  WorkjetCrossModeError,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type EnvironmentId,
  type ThreadId,
  type TurnId,
  type WorkjetArtifactReferences,
  type WorkjetBusinessOsObjectId,
  type WorkjetBusinessOsObjectKind,
  type WorkjetCrossModeCtoxRef,
  type WorkjetCrossModeLinkId,
  type WorkjetCrossModeOperation,
  type WorkjetCrossModeResultOutcome,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The ONE boundary between this server and a CTOX authority for the cross-mode
 * bridge: authority verification, and the dispatch of a validated Business OS
 * command.
 *
 * WHY THIS IS A PORT AND NOT AN IMPLEMENTATION. What the T3 server can reach
 * today was established by reading the code, not assumed:
 *
 * - There is NO MCP client anywhere in this repository. `apps/server` mounts an
 *   MCP *server* (`apps/server/src/mcp/McpHttpServer.ts`) and exposes toolkits
 *   to agents; it never connects out to a CTOX daemon's `POST /mcp`. A search
 *   for `StdioClientTransport` / `SSEClientTransport` / `StreamableHTTPClient`
 *   over `apps/` and `packages/` returns nothing.
 * - The only outbound wire from `apps/server` to a CTOX daemon is the mailbox
 *   loopback transport (`../mailbox/WorkjetMailboxTransport.ts`), and it is
 *   explicitly opaque: the daemon "treats `envelope_json` and `payload_json` as
 *   OPAQUE bounded blobs — it never parses, verifies, or interprets them". A
 *   replication pipe cannot express a Business OS command, and widening it to
 *   carry one would be exactly the alternate data path the plan forbids.
 * - Business OS commands travel today through the DESKTOP:
 *   renderer → `desktop:ctox-*` IPC (`apps/desktop/src/ipc/channels.ts`) →
 *   `CtoxGuestManager.executeJavaScript` into the guest `WebContentsView` →
 *   `globalThis.CTOX_BUSINESS_OS_APP`. `apps/server` has no hop on that path,
 *   and `packages/contracts/src/ipc.ts` carries no desktop-main ↔ server channel
 *   for it.
 *
 * So the server half is implemented here in full — validation, authority check,
 * durable link, thread creation, activity trace, approval mapping — and the last
 * hop is this port. Its only implementation in this slice is
 * {@link WorkjetCrossModeCtoxPortUnavailable}, which verifies NO authority and
 * dispatches NOTHING. That is the honest state of the boundary: a cross-mode
 * link cannot be created until something can vouch for a CTOX instance, and a
 * `Return to Business OS` refuses with `ctox-command-unavailable` rather than
 * pretending it landed.
 *
 * The remaining step is a real implementation of THIS interface over the CTOX
 * daemon's typed `business_os.*` MCP surface (the daemon's loopback listener,
 * the same origin and bearer token `WorkjetMailboxTransport` already resolves
 * from `<CTOX_STATE_ROOT>/instance.json` and
 * `ctox secret get --scope business_os --name mcp_inbound_auth_token`) — or, if
 * the boundary is to stay in the desktop, a desktop-main implementation reached
 * over a new IPC channel. Either way the shape above is what it must satisfy,
 * and nothing upstream of it changes.
 */

// ===============================
// The command
// ===============================

/**
 * One validated Business OS command, in typed form.
 *
 * Every field is either a reference or a bounded, operator-authored string that
 * already crossed the contract's redaction checks. There is no record, no
 * payload, no credential, and no free-form action name: the `operation` is the
 * contract's closed literal set, so a caller cannot ask the CTOX authority to
 * run something this bridge did not define.
 *
 * The object reference is spread flat rather than carried as a
 * {@link WorkjetCrossModeCtoxRef} because the CTOX side addresses an object by
 * these four values and an implementation should not have to reach through a
 * wrapper — but they are ALWAYS copied from the stored link, never from a
 * request. See `WorkjetCrossModeRpc.submit`.
 */
export interface WorkjetCrossModeCtoxCommand {
  readonly instanceId: CtoxManagedInstanceId;
  readonly moduleId: CtoxAppModuleId;
  readonly objectKind: WorkjetBusinessOsObjectKind;
  readonly objectId: WorkjetBusinessOsObjectId;
  readonly operation: WorkjetCrossModeOperation;
  /** Bounded, operator-facing evidence summary. Never a diff and never a record. */
  readonly summary: string;
  /** Bounded references only — branch, commit hashes, repository-relative paths. */
  readonly artifacts: WorkjetArtifactReferences;
  /** Present on `submit-result`. */
  readonly outcome?: WorkjetCrossModeResultOutcome;
  /** The turn the evidence came out of, when known. */
  readonly runTurnId?: TurnId;
  /** The link this command belongs to, so the authority can correlate it. */
  readonly linkId: WorkjetCrossModeLinkId;
  readonly codeEnvironmentId: EnvironmentId;
  readonly codeThreadId: ThreadId;
}

/**
 * What the CTOX authority did with a dispatched command.
 *
 * The two outcomes are exactly CTOX's own approval model — execute versus
 * propose-and-await-a-human — surfaced without reinterpretation. T3 does not add
 * a second gate on top; it reports which side of CTOX's gate the command landed
 * on, and the contract maps that onto the repository's existing
 * `WorkjetDelegationApprovalState` vocabulary (`not-required` / `pending`).
 *
 * There is deliberately no `applied` and no `delivered`: this server cannot
 * observe what the Business OS ultimately did, and a word implying it could
 * would be a claim the bridge cannot support.
 */
export type WorkjetCrossModeCtoxDispatch =
  | { readonly _tag: "dispatched" }
  | { readonly _tag: "awaiting-approval" };

// ===============================
// The port
// ===============================

export interface WorkjetCrossModeCtoxPortShape {
  /**
   * Can this server vouch for the named CTOX instance RIGHT NOW?
   *
   * This is the whole authority rule. The caller's `instanceId` is never taken
   * as truth: it is handed to the authority that can observe CTOX and either
   * confirmed or refused. An implementation that cannot observe anything answers
   * `false` for every id, which refuses every link — the correct behaviour, not
   * a degraded one, because a link to an unverifiable authority is a link to
   * nothing.
   *
   * It returns a plain boolean rather than a descriptor on purpose: a caller
   * that could read instance metadata through this call would have a second,
   * unaudited window into the CTOX authority's state.
   */
  readonly verifyAuthority: (
    instanceId: CtoxManagedInstanceId,
  ) => Effect.Effect<boolean, WorkjetCrossModeError>;

  /**
   * Dispatch one validated command through the CTOX MCP command surface.
   *
   * Fails with `ctox-command-unavailable` when the surface is not reachable —
   * which is NOT a validation failure, the request was well formed and
   * authorized — and with `ctox-command-rejected` when the CTOX authority itself
   * refused. Whatever it said stays on its side of the boundary.
   */
  readonly dispatch: (
    command: WorkjetCrossModeCtoxCommand,
  ) => Effect.Effect<WorkjetCrossModeCtoxDispatch, WorkjetCrossModeError>;
}

export class WorkjetCrossModeCtoxPort extends Context.Service<
  WorkjetCrossModeCtoxPort,
  WorkjetCrossModeCtoxPortShape
>()("t3/workjet/crossmode/WorkjetCrossModeCtoxPort") {}

/**
 * The only implementation this slice ships: no authority is verifiable and no
 * command is dispatchable.
 *
 * It is a real, correct implementation of "this server currently has no
 * validated CTOX command channel", not a stub that pretends. Wiring it means
 * every cross-mode operation refuses with a bounded, accurate reason instead of
 * silently doing nothing or inventing a data path.
 */
export const workjetCrossModeCtoxPortUnavailable: WorkjetCrossModeCtoxPortShape = {
  verifyAuthority: () => Effect.succeed(false),
  dispatch: () => Effect.fail(new WorkjetCrossModeError({ reason: "ctox-command-unavailable" })),
};

export const WorkjetCrossModeCtoxPortUnavailable = Layer.succeed(
  WorkjetCrossModeCtoxPort,
  workjetCrossModeCtoxPortUnavailable,
);

/**
 * Verify the CTOX side of a reference, or refuse.
 *
 * Deliberately one function shared by every entrypoint: an operation that
 * forgot to call it would be the ambient-authority bug this whole module exists
 * to prevent, and having exactly one call site per operation makes that
 * auditable by reading.
 */
export const requireVerifiedCtoxAuthority = (
  port: WorkjetCrossModeCtoxPortShape,
  ctox: WorkjetCrossModeCtoxRef,
): Effect.Effect<void, WorkjetCrossModeError> =>
  port
    .verifyAuthority(ctox.instanceId)
    .pipe(
      Effect.flatMap((verified) =>
        verified
          ? Effect.void
          : Effect.fail(new WorkjetCrossModeError({ reason: "unverified-authority" })),
      ),
    );
