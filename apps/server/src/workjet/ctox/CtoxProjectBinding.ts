import {
  normalizeWorkjetThreadConfig,
  type ProjectId,
  type ThreadId,
  type WorkjetConnectionId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { requireCtoxConnectionInstance } from "./CtoxConnectionBinding.ts";

export class CtoxProjectBindingError extends Schema.TaggedErrorClass<CtoxProjectBindingError>()(
  "CtoxProjectBindingError",
  {
    reason: Schema.Literals([
      "no-confirmed-project",
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
  readonly projectId: ProjectId;
  readonly config: WorkjetThreadConfig;
  /** The explicit CTOX capability binding already resolved for this thread. */
  readonly binding:
    | { readonly connectionId: WorkjetConnectionId; readonly instanceId: string }
    | undefined;
}

/** Resolve the persisted native project confirmed by guest session.create.
 * A physical Workjet project ID is never used as a fallback native ID.
 * CTOX still authorizes the project owner when the resulting operation runs.
 */
export const resolveCtoxProjectBinding = Effect.fn("ctox.resolveProjectBinding")(function* (
  input: CtoxProjectBindingInput,
) {
  const fail = (reason: CtoxProjectBindingError["reason"]) =>
    new CtoxProjectBindingError({ reason });
  const config = normalizeWorkjetThreadConfig(input.config);
  const project = config.ctoxProject;
  if (project === undefined) return yield* fail("no-confirmed-project");
  if (project.codeThreadId !== input.threadId || project.codeProjectId !== input.projectId)
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
