import type { NativeBusinessDataRecord } from "@workjet/contracts/ctoxBusinessData";
import * as Schema from "effect/Schema";

import type { ProjectChatRow, ProjectChatViewScope, ProjectWorkerRow } from "./projectChats.ts";

// Projection of existing CTOX collection fields, not a new wire contract.
// Source: business_os_schema_contract.json workjet_project_chats/workers.
const common = {
  id: Schema.String,
  project_id: Schema.String,
  owner_user_id: Schema.String,
  created_at_ms: Schema.Number,
  updated_at_ms: Schema.Number,
  is_deleted: Schema.optionalKey(Schema.Boolean),
};
const Chat = Schema.Struct({
  ...common,
  thread_id: Schema.String,
  kind: Schema.Literals(["group", "private"]),
  worker_profile_id: Schema.optionalKey(Schema.String),
  initial: Schema.Boolean,
});
const Member = Schema.Struct({
  ...common,
  group_chat_id: Schema.String,
  worker_profile_id: Schema.String,
  status: Schema.Literals(["active", "removed"]),
});
// Unknown source metadata is omitted, never spread into the presentation.
const decodeChat = Schema.decodeUnknownSync(Chat);
const decodeMember = Schema.decodeUnknownSync(Member);
function validId(value: string, max = 256): boolean {
  return (
    value.length > 0 &&
    [...value].length <= max &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}
function commonValid(row: typeof Chat.Type | typeof Member.Type, scope: ProjectChatViewScope) {
  return (
    validId(row.id) &&
    validId(row.project_id, 128) &&
    validId(row.owner_user_id) &&
    row.project_id === scope.projectId &&
    row.owner_user_id === scope.userId &&
    Number.isFinite(row.created_at_ms) &&
    Number.isFinite(row.updated_at_ms)
  );
}
export type ProjectChatRecords =
  | {
      readonly status: "valid";
      readonly chats: readonly ProjectChatRow[];
      readonly members: readonly ProjectWorkerRow[];
    }
  | { readonly status: "invalid"; readonly chats: readonly []; readonly members: readonly [] };

/**
 * Decode complete record sets supplied by the authenticated native consumer.
 * This does not verify session identity or establish cross-collection snapshot
 * coherence. The owner must verify those BEFORE calling and before publication.
 * Any malformed/mis-scoped record rejects the entire view, including tombstones.
 */
export function decodeProjectChatRecords(
  scope: ProjectChatViewScope,
  chatRecords: readonly NativeBusinessDataRecord[],
  memberRecords: readonly NativeBusinessDataRecord[],
): ProjectChatRecords {
  const invalid = (): ProjectChatRecords => ({ status: "invalid", chats: [], members: [] });
  if (
    ![scope.instanceId, scope.userId, scope.generation].every((id) => validId(id)) ||
    !validId(scope.projectId, 128)
  )
    return invalid();
  try {
    const chats: ProjectChatRow[] = [];
    const members: ProjectWorkerRow[] = [];
    const chatIds = new Set<string>();
    const memberIds = new Set<string>();
    for (const record of chatRecords) {
      const row = decodeChat(record.document);
      if (
        !commonValid(row, scope) ||
        record.documentId !== row.id ||
        chatIds.has(row.id) ||
        !validId(row.thread_id) ||
        (row.kind === "group"
          ? !row.initial || row.worker_profile_id !== undefined
          : row.worker_profile_id === undefined || !validId(row.worker_profile_id))
      )
        return invalid();
      chatIds.add(row.id);
      chats.push(row);
    }
    for (const record of memberRecords) {
      const row = decodeMember(record.document);
      if (
        !commonValid(row, scope) ||
        record.documentId !== row.id ||
        memberIds.has(row.id) ||
        !validId(row.group_chat_id) ||
        !validId(row.worker_profile_id)
      )
        return invalid();
      memberIds.add(row.id);
      members.push(row);
    }
    return { status: "valid", chats, members };
  } catch {
    return invalid();
  }
}
