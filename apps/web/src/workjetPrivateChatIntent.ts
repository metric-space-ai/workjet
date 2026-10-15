import { CommandId, IsoDateTime, ProjectId, WorkjetConnectionId } from "@workjet/contracts";
import * as Schema from "effect/Schema";

// Draft-owned write-ahead intent retains project ownership after binding.
// Draft persistence must not depend on project control or other UI modules.
export const WorkjetPrivateChatIntent = Schema.Struct({
  instanceId: Schema.String,
  connectionId: WorkjetConnectionId,
  projectId: ProjectId,
  workerProfileId: Schema.String,
  separate: Schema.Boolean,
  membershipCommandId: CommandId,
  chatCommandId: CommandId,
  createdAt: IsoDateTime,
});
export type WorkjetPrivateChatIntent = typeof WorkjetPrivateChatIntent.Type;

export function samePrivateChatIntentScope(
  a: WorkjetPrivateChatIntent,
  b: WorkjetPrivateChatIntent,
): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.connectionId === b.connectionId &&
    a.projectId === b.projectId &&
    a.workerProfileId === b.workerProfileId &&
    a.separate === b.separate
  );
}
