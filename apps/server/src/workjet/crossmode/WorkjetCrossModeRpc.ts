import {
  WORKJET_CROSS_MODE_LINK_LIST_MAX,
  WorkjetCrossModeError,
  WorkjetCrossModeLinkId,
  type EnvironmentId,
  type OrchestrationThread,
  type ThreadId,
  type WorkjetCrossModeActivityPayload,
  type WorkjetCrossModeGetThreadLinkRpcInput,
  type WorkjetCrossModeGetThreadLinkRpcResult,
  type WorkjetCrossModeLink,
  type WorkjetCrossModeListLinksRpcInput,
  type WorkjetCrossModeListLinksRpcResult,
  type WorkjetCrossModeOpenInCodeRpcInput,
  type WorkjetCrossModeOpenInCodeRpcResult,
  type WorkjetCrossModeSubmitRpcInput,
  type WorkjetCrossModeSubmitRpcResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import {
  boundCrossModeStoreError,
  type WorkjetCrossModeLinkRecord,
  type WorkjetCrossModeLinkStoreShape,
} from "./WorkjetCrossModeLinkStore.ts";
import {
  requireVerifiedCtoxAuthority,
  type WorkjetCrossModeCtoxPortShape,
} from "./WorkjetCrossModeCtoxPort.ts";

/**
 * The WebSocket half of the cross-mode workflow bridge (docs/workjet-plan.md →
 * "Cross-mode workflow bridge", items 1–3).
 *
 * It is a pure handler factory with no service dependencies, exactly like
 * `../mailbox/WorkjetMailboxRpc.ts`: every capability it needs — the durable
 * link store, the CTOX command boundary, thread reads, thread creation, the
 * activity append, the clock, and the id source — arrives as an injected port,
 * so the whole authorization story is testable without a server.
 *
 * AUTHORITY, the rule this module exists to enforce. Two authorities meet here
 * and NEITHER is taken from the caller:
 *
 * - The CODE authority is `dependencies.environmentId`, this server's own. The
 *   `Open in Code` input has no `environmentId` field to override it, and a
 *   stored link whose `code.environmentId` is not this server's is refused with
 *   `unauthorized` rather than acted on — a database file carried between
 *   machines cannot make this server act as another one.
 * - The CTOX authority is re-verified on EVERY operation through
 *   {@link requireVerifiedCtoxAuthority}. The caller names an instance; the port
 *   confirms or refuses it. A renderer-invented instance id is
 *   `unverified-authority`, always, and never becomes a durable link.
 *
 * The thread-level rule mirrors the mailbox's: the caller-named thread must
 * exist, must not be deleted, and — for the Business-OS-side write that CREATES
 * a thread — must be an orchestrator thread. A thread that fails any part of
 * that gets the single bounded reason `unauthorized`; the cases are not
 * distinguished on the wire, because a client that may not act from a thread
 * also may not learn from the error whether that thread exists.
 */

/** Only the read this module performs, so tests can supply a double. */
export interface WorkjetCrossModeThreadQuery {
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;
}

/**
 * Thread creation and the durable activity trace, as a port.
 *
 * `createLinkedThread` inherits the host thread's project, model selection,
 * runtime mode, and interaction mode and starts its first turn from the seeded
 * brief — the same settings-template inheritance the handoff accept performs,
 * for the same reason: the Business OS side knows nothing about this machine's
 * projects, and inventing one would be a guess.
 *
 * `deleteThread` exists because create-or-select can LOSE: the thread is created
 * before the durable claim (a claim taken first would need a thread id chosen
 * before the thread exists, and a failed creation would leave a link pointing at
 * a thread nobody can open). When the store reports that another request already
 * linked the object, the brand-new unreferenced thread this call made is removed.
 */
export interface WorkjetCrossModeThreadPort {
  readonly createLinkedThread: (input: {
    readonly hostThread: OrchestrationThread;
    readonly title: string;
    readonly seedMessage: string;
    readonly createdAt: string;
  }) => Effect.Effect<ThreadId, WorkjetCrossModeError>;

  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void>;

  /**
   * Best-effort redacted thread activity. The link store is authoritative for
   * the link, so a rejected append must not turn a stored link into a reported
   * failure — the same rule the mailbox applies to its own activity writes.
   */
  readonly appendActivity: (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly payload: WorkjetCrossModeActivityPayload;
    readonly createdAt: string;
  }) => Effect.Effect<void>;
}

export interface WorkjetCrossModeRpcDependencies {
  readonly links: WorkjetCrossModeLinkStoreShape;
  readonly ctox: WorkjetCrossModeCtoxPortShape;
  readonly query: WorkjetCrossModeThreadQuery;
  readonly threads: WorkjetCrossModeThreadPort;
  /** This server's own environment id — the Code authority, never caller-supplied. */
  readonly environmentId: EnvironmentId;
  /** Injected so a link's timestamps and id are deterministic under test. */
  readonly nowIso: Effect.Effect<string>;
  readonly randomUUID: Effect.Effect<string>;
}

export interface WorkjetCrossModeRpcHandlers {
  readonly openInCode: (
    input: WorkjetCrossModeOpenInCodeRpcInput,
  ) => Effect.Effect<WorkjetCrossModeOpenInCodeRpcResult, WorkjetCrossModeError>;
  readonly getThreadLink: (
    input: WorkjetCrossModeGetThreadLinkRpcInput,
  ) => Effect.Effect<WorkjetCrossModeGetThreadLinkRpcResult, WorkjetCrossModeError>;
  readonly listLinks: (
    input: WorkjetCrossModeListLinksRpcInput,
  ) => Effect.Effect<WorkjetCrossModeListLinksRpcResult, WorkjetCrossModeError>;
  readonly submit: (
    input: WorkjetCrossModeSubmitRpcInput,
  ) => Effect.Effect<WorkjetCrossModeSubmitRpcResult, WorkjetCrossModeError>;
}

export const WORKJET_CROSS_MODE_LINKED_ACTIVITY_KIND = "workjet.crossmode.linked";
export const WORKJET_CROSS_MODE_RETURNED_ACTIVITY_KIND = "workjet.crossmode.returned";

const failure = (reason: WorkjetCrossModeError["reason"]) => new WorkjetCrossModeError({ reason });

/**
 * The scoped context, as the first user message of the linked Code thread.
 *
 * It states the two references and then the operator's brief, and nothing else.
 * There is no record here because there is no record anywhere in this bridge:
 * whatever Code needs to know was written by a human into `context.brief`, which
 * makes the disclosure decision visible instead of implicit in a serializer.
 */
export const composeCrossModeSeedMessage = (input: {
  readonly link: Pick<WorkjetCrossModeLink, "ctox" | "presentation">;
  readonly brief: string;
}): string => {
  const { ctox, presentation } = input.link;
  const lines = [
    "# Business OS work item",
    "",
    `Title: ${presentation.title}`,
    ...(presentation.subtitle !== undefined ? [`Subtitle: ${presentation.subtitle}`] : []),
    `Business OS object: ${ctox.moduleId}/${ctox.objectKind}/${ctox.objectId}`,
    `CTOX instance: ${ctox.instanceId}`,
    "",
    "This thread is linked to the work item above. Results, review requests, and",
    "follow-ups return to it through the CTOX command boundary; the Business OS",
    "record itself stays in its own authority and is not reproduced here.",
    "",
    "## Scope",
    "",
    input.brief,
  ];
  return lines.join("\n");
};

const isExpired = (record: WorkjetCrossModeLinkRecord, nowMillis: number): boolean =>
  record.expiresAtMillis !== null && record.expiresAtMillis <= nowMillis;

export const makeWorkjetCrossModeRpcHandlers = (
  dependencies: WorkjetCrossModeRpcDependencies,
): WorkjetCrossModeRpcHandlers => {
  const nowMillis = dependencies.nowIso.pipe(
    Effect.map((iso) =>
      Option.match(DateTime.make(iso), {
        onNone: () => 0,
        onSome: DateTime.toEpochMillis,
      }),
    ),
  );

  /** The thread must exist and must not be deleted. Nothing weaker is a thread. */
  const requireLiveThread = (threadId: ThreadId) =>
    dependencies.query.getThreadDetailById(threadId).pipe(
      Effect.mapError(() => failure("cross-mode-unavailable")),
      Effect.flatMap((option) =>
        Option.match(option, {
          onNone: () => Effect.fail(failure("unauthorized")),
          onSome: (thread) =>
            thread.deletedAt !== null
              ? Effect.fail(failure("unauthorized"))
              : Effect.succeed(thread),
        }),
      ),
    );

  /**
   * The host thread of a delegation must additionally be an ORCHESTRATOR thread.
   * Creating a thread and starting a turn on it is the same class of write as a
   * mailbox delegation, so it carries the same second check.
   */
  const requireOrchestratorHost = (threadId: ThreadId) =>
    requireLiveThread(threadId).pipe(
      Effect.flatMap((thread) =>
        thread.workjetConfig.role !== "orchestrator"
          ? Effect.fail(failure("unauthorized"))
          : Effect.succeed(thread),
      ),
    );

  const activityPayload = (input: {
    readonly link: WorkjetCrossModeLink;
    readonly direction: WorkjetCrossModeActivityPayload["direction"];
    readonly operation?: WorkjetCrossModeSubmitRpcInput["operation"];
    readonly approval?: WorkjetCrossModeSubmitRpcResult["approval"];
    readonly createdAt: string;
  }): WorkjetCrossModeActivityPayload => ({
    schemaVersion: 1,
    linkId: input.link.linkId,
    direction: input.direction,
    ctox: input.link.ctox,
    code: input.link.code,
    title: input.link.presentation.title,
    ...(input.operation !== undefined ? { operation: input.operation } : {}),
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
    createdAt: input.createdAt,
  });

  const openInCode: WorkjetCrossModeRpcHandlers["openInCode"] = Effect.fn(
    "WorkjetCrossModeRpc.openInCode",
  )(function* (input) {
    // Authority first, in both directions, BEFORE any durable effect and before
    // a thread is created: an unverifiable CTOX instance must not be able to
    // cost this machine a thread.
    const host = yield* requireOrchestratorHost(input.hostThreadId);
    yield* requireVerifiedCtoxAuthority(dependencies.ctox, input.ctox);

    const now = yield* dependencies.nowIso;
    const nowAt = yield* nowMillis;

    // SELECT before CREATE. The database's unique index is the real invariant,
    // but reading first means the ordinary second click never creates and then
    // deletes a thread.
    const existing = yield* dependencies.links
      .getByObject(input.ctox)
      .pipe(Effect.mapError(boundCrossModeStoreError));
    const selected = Option.filter(existing, (record) => !isExpired(record, nowAt));
    if (Option.isSome(selected)) {
      // DELETED COUNTERPART. The stored link is live and unexpired, but the Code
      // thread it names may since have been deleted. Handing that link back would
      // answer "Open in Code" with a thread nobody can open, so the counterpart is
      // re-checked before the link is returned as a selection. The refusal is the
      // contract's `unauthorized`, which is documented to cover exactly "missing,
      // deleted, or not permitted" and is the same answer `submit` gives for the
      // same thread — the link ROW is deliberately left in place, because a
      // deleted thread is history, not a reason to erase the record of the work.
      yield* requireLiveThread(selected.value.link.code.threadId);
      return {
        schemaVersion: 1,
        selection: "selected",
        link: selected.value.link,
      } as const;
    }
    if (Option.isSome(existing)) {
      // A link exists but has expired. Refusing is the honest answer: silently
      // re-linking would discard an operator's deliberate time box, and quietly
      // reusing the expired link would contradict its own contract.
      return yield* failure("link-expired");
    }

    const linkId = WorkjetCrossModeLinkId.make(`wjx-${yield* dependencies.randomUUID}`);
    const threadId = yield* dependencies.threads.createLinkedThread({
      hostThread: host,
      title: input.presentation.title,
      seedMessage: composeCrossModeSeedMessage({
        link: { ctox: input.ctox, presentation: input.presentation },
        brief: input.context.brief,
      }),
      createdAt: now,
    });

    const link: WorkjetCrossModeLink = {
      schemaVersion: 1,
      linkId,
      ctox: input.ctox,
      code: {
        schemaVersion: 1,
        // The Code authority, taken from this server and never from the caller.
        environmentId: dependencies.environmentId,
        threadId,
      },
      presentation: input.presentation,
      createdAt: now,
    };

    const outcome = yield* dependencies.links.createOrSelect(link).pipe(
      Effect.mapError(boundCrossModeStoreError),
      // A lost race, or a thread that somehow already carried a link: the
      // brand-new thread this call created is unreferenced, so removing it keeps
      // "one object, one Code thread" true from the operator's point of view.
      Effect.tapError(() => dependencies.threads.deleteThread(threadId)),
    );

    if (outcome._tag === "existing") {
      yield* dependencies.threads.deleteThread(threadId);
      return {
        schemaVersion: 1,
        selection: "selected",
        link: outcome.record.link,
      } as const;
    }

    // The durable backlink, on the NEW thread's own event stream: a reader of
    // that thread learns which Business OS object it implements without ever
    // querying the link table.
    yield* dependencies.threads.appendActivity({
      threadId,
      kind: WORKJET_CROSS_MODE_LINKED_ACTIVITY_KIND,
      summary: "Linked to a Business OS work item",
      payload: activityPayload({
        link: outcome.record.link,
        direction: "to-code",
        createdAt: now,
      }),
      createdAt: now,
    });

    return { schemaVersion: 1, selection: "created", link: outcome.record.link } as const;
  });

  const getThreadLink: WorkjetCrossModeRpcHandlers["getThreadLink"] = Effect.fn(
    "WorkjetCrossModeRpc.getThreadLink",
  )(function* (input) {
    yield* requireLiveThread(input.threadId);
    const record = yield* dependencies.links
      .getByThread(input.threadId)
      .pipe(Effect.mapError(boundCrossModeStoreError));
    return Option.match(record, {
      onNone: () => ({ schemaVersion: 1 }) as const,
      onSome: (value) => ({ schemaVersion: 1, link: value.link }) as const,
    });
  });

  const listLinks: WorkjetCrossModeRpcHandlers["listLinks"] = Effect.fn(
    "WorkjetCrossModeRpc.listLinks",
  )(function* (input) {
    const records = yield* dependencies.links
      .list(input.limit ?? WORKJET_CROSS_MODE_LINK_LIST_MAX)
      .pipe(Effect.mapError(boundCrossModeStoreError));
    return { schemaVersion: 1, links: records.map((record) => record.link) } as const;
  });

  const submit: WorkjetCrossModeRpcHandlers["submit"] = Effect.fn("WorkjetCrossModeRpc.submit")(
    function* (input) {
      const record = yield* dependencies.links
        .getById(input.linkId)
        .pipe(Effect.mapError(boundCrossModeStoreError));
      const stored = yield* Option.match(record, {
        onNone: () => Effect.fail(failure("unknown-link")),
        onSome: (value) => Effect.succeed(value),
      });
      const link = stored.link;

      // A submission may only be made FROM the link's own Code thread. Naming a
      // different one is `unknown-link`, not `unauthorized`: from the caller's
      // point of view there is no such link on that thread, and the two answers
      // must not let it probe which links exist elsewhere.
      if (link.code.threadId !== input.threadId) {
        return yield* failure("unknown-link");
      }
      // A link whose Code authority is not this server is not this server's to
      // act on, however it got into the database.
      if (link.code.environmentId !== dependencies.environmentId) {
        return yield* failure("unauthorized");
      }
      yield* requireLiveThread(input.threadId);

      const now = yield* dependencies.nowIso;
      if (isExpired(stored, yield* nowMillis)) {
        return yield* failure("link-expired");
      }

      // Re-verified on every reverse operation, not just at link creation: an
      // instance that was verifiable yesterday may be revoked today, and a
      // durable row is not a standing authorization.
      yield* requireVerifiedCtoxAuthority(dependencies.ctox, link.ctox);

      // The counterpart address comes ENTIRELY from the stored link.
      const dispatch = yield* dependencies.ctox.dispatch({
        instanceId: link.ctox.instanceId,
        moduleId: link.ctox.moduleId,
        objectKind: link.ctox.objectKind,
        objectId: link.ctox.objectId,
        operation: input.operation,
        summary: input.evidence.summary,
        artifacts: input.evidence.artifacts,
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.evidence.runTurnId !== undefined ? { runTurnId: input.evidence.runTurnId } : {}),
        linkId: link.linkId,
        codeEnvironmentId: link.code.environmentId,
        codeThreadId: link.code.threadId,
      });

      const approval = dispatch._tag === "dispatched" ? "not-required" : "pending";

      yield* dependencies.threads.appendActivity({
        threadId: input.threadId,
        kind: WORKJET_CROSS_MODE_RETURNED_ACTIVITY_KIND,
        summary: "Returned to the Business OS work item",
        payload: activityPayload({
          link,
          direction: "to-business-os",
          operation: input.operation,
          approval,
          createdAt: now,
        }),
        createdAt: now,
      });

      return {
        schemaVersion: 1,
        linkId: link.linkId,
        operation: input.operation,
        status: dispatch._tag,
        approval,
        submittedAt: now,
      } as const;
    },
  );

  return { openInCode, getThreadLink, listLinks, submit };
};
