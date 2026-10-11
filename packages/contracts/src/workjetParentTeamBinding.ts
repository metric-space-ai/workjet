import * as Schema from "effect/Schema";
import type { ProjectId, ThreadId } from "./baseSchemas.ts";
import type { WorkjetProjectTeamMember } from "./workjetProjectTeam.ts";

const NativeId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const NativeThreadId = Schema.String.check(
  Schema.isPattern(
    /^(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  ),
);

/** Complete Owner-issued private native enrollment reference, never an execution permit. */
export const WorkjetParentTeamBinding = Schema.Struct({
  contract: Schema.Literal("ctox.workjet.persistent-worker-binding.v1"),
  owner_user_id: NativeId,
  project_id: NativeId,
  supervisor_thread_id: NativeThreadId,
  thread_id: NativeThreadId,
  role: Schema.Literal("persistent_worker"),
  revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  state: Schema.Literal("active"),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkjetParentTeamBinding = typeof WorkjetParentTeamBinding.Type;

export const sameWorkjetParentTeamBinding = Schema.toEquivalence(
  Schema.UndefinedOr(WorkjetParentTeamBinding),
);

/** Presentation affiliation is only a consistency fence; native private enrollment grants authority. */
export function workjetParentBindingMatchesTeam(
  binding: WorkjetParentTeamBinding | undefined,
  team: WorkjetProjectTeamMember | undefined,
  projectId: ProjectId,
  threadId: ThreadId,
): boolean {
  return (
    binding === undefined ||
    (team?.role === "specialist" &&
      team.projectId === projectId &&
      team.threadId === threadId &&
      binding.project_id === projectId &&
      binding.thread_id === threadId &&
      binding.supervisor_thread_id === team.parentThreadId &&
      binding.supervisor_thread_id !== binding.thread_id)
  );
}
