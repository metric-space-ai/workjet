import {
  normalizeWorkjetThreadConfig,
  type ThreadId,
  type WorkjetConnectionId,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { requireCtoxConnectionInstance } from "./CtoxConnectionBinding.ts";

export class CtoxProjectBindingError extends Schema.TaggedErrorClass<CtoxProjectBindingError>()(
  "CtoxProjectBindingError",
  {
    reason: Schema.Literals([
      "no-confirmed-project",
      "thread-unavailable",
      "thread-read-unavailable",
      "thread-project-mismatch",
      "session-mismatch",
      "no-thread-binding",
      "instance-mismatch",
      "connection-unverified",
    ]),
  },
) {}

export interface CtoxProjectBindingInput {
  readonly threadId: ThreadId;
  /** The explicit CTOX capability binding already resolved for this thread. */
  readonly binding:
    | { readonly connectionId: WorkjetConnectionId; readonly instanceId: string }
    | undefined;
}

/** Resolve the persisted native project confirmed by guest session.create.
 * A physical Workjet project ID is never used as a fallback native ID.
 * The physical project and configuration are read from the server's active
 * thread projection. CTOX still authorizes the project owner on execution.
 */
export const resolveCtoxProjectBinding = Effect.fn("ctox.resolveProjectBinding")(function* (
  input: CtoxProjectBindingInput,
) {
  const fail = (reason: CtoxProjectBindingError["reason"]) =>
    new CtoxProjectBindingError({ reason });
  const query = yield* ProjectionSnapshotQuery;
  const projected = yield* query
    .getThreadShellById(input.threadId)
    .pipe(Effect.mapError(() => fail("thread-read-unavailable")));
  if (Option.isNone(projected)) return yield* fail("thread-unavailable");
  const thread = projected.value;
  const config = normalizeWorkjetThreadConfig(thread.workjetConfig);
  const project = config.ctoxProject;
  if (project === undefined) return yield* fail("no-confirmed-project");
  if (
    thread.id !== input.threadId ||
    project.codeThreadId !== thread.id ||
    project.codeProjectId !== thread.projectId
  )
    return yield* fail("thread-project-mismatch");
  const session = config.ctoxSession;
  if (
    session === null ||
    session === undefined ||
    session.sessionId !== project.nativeSessionId ||
    session.instanceId !== project.presentationInstanceId
  )
    return yield* fail("session-mismatch");
  if (input.binding === undefined) return yield* fail("no-thread-binding");
  if (project.businessOsInstanceId !== input.binding.instanceId)
    return yield* fail("instance-mismatch");

  yield* requireCtoxConnectionInstance(
    input.binding.connectionId,
    project.businessOsInstanceId,
  ).pipe(Effect.mapError(() => fail("connection-unverified")));

  return {
    connectionId: input.binding.connectionId,
    instanceId: project.businessOsInstanceId,
    nativeProjectId: project.nativeProjectId,
    workingCopyId: project.workingCopyId,
    nativeSessionId: project.nativeSessionId,
  };
});
