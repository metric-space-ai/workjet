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
 * WHY IT IS A PORT. Everything upstream of this interface — validation, the
 * authority check, the durable link, thread creation, the activity trace, the
 * approval mapping — is this server's own business and is tested against a
 * double. Only the last hop touches another authority, and keeping that hop
 * behind one two-method interface is what makes "a caller can never name an
 * unverified instance" auditable by reading rather than by trust.
 *
 * ITS IMPLEMENTATIONS.
 *
 * - {@link WorkjetCrossModeCtoxPortUnavailable} verifies NO authority and
 *   dispatches NOTHING. It is a real, correct implementation of "this server
 *   has no validated CTOX command channel" — the honest state on a machine with
 *   no local daemon — not a stub that pretends.
 * - `WorkjetCrossModeCtoxClient` is the live one, a bounded JSON-RPC client over
 *   the local daemon's `POST /mcp` surface on the same loopback origin and
 *   behind the same bearer token `WorkjetMailboxTransport` already resolves from
 *   `<CTOX_STATE_ROOT>/instance.json` and
 *   `ctox secret get --scope business_os --name mcp_inbound_auth_token`. It
 *   verifies an instance against the identity the running daemon publishes in
 *   its own descriptor and dispatches through `business_os.execute_action`.
 *   Because it re-resolves both the descriptor and the token on every call, it
 *   degrades to exactly the unavailable behaviour when no daemon is running —
 *   which is why `ws.ts` needs no "is CTOX installed" branch.
 *
 * There is deliberately no second data path. The mailbox loopback transport is
 * explicitly opaque — the daemon "treats `envelope_json` and `payload_json` as
 * OPAQUE bounded blobs" — so a replication pipe cannot express a Business OS
 * command, and widening it to carry one would be the alternate data path the
 * plan forbids. The desktop's own route (renderer → `desktop:ctox-*` IPC →
 * `CtoxGuestManager.executeJavaScript` → `globalThis.CTOX_BUSINESS_OS_APP`)
 * stays the desktop's; this server reaches CTOX only through the typed,
 * policy-gated, audited MCP surface.
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
