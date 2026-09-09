export { decodeProjectChatRecords, type ProjectChatRecords } from "./projectChatRecords.ts";

/**
 * Read-only inputs from validated native projections, not a wire contract or
 * permission model. The host consumer owns decoding, coherent snapshots and
 * revocation. Titles and execution sessions remain in their existing stores.
 */
export interface ProjectChatRow {
  readonly id: string;
  readonly thread_id: string;
  readonly project_id: string;
  readonly owner_user_id: string;
  readonly kind: "group" | "private";
  readonly worker_profile_id?: string;
  readonly initial: boolean;
  readonly created_at_ms: number;
  readonly is_deleted?: boolean;
}

export interface ProjectWorkerRow {
  readonly id: string;
  readonly project_id: string;
  readonly owner_user_id: string;
  readonly group_chat_id: string;
  readonly worker_profile_id: string;
  readonly status: "active" | "removed";
  readonly created_at_ms: number;
  readonly is_deleted?: boolean;
}

/** Local view identity copied from the authenticated host session. */
export interface ProjectChatViewScope {
  readonly instanceId: string;
  readonly userId: string;
  readonly generation: string;
  readonly projectId: string;
}

export interface ProjectChatSnapshot<
  Chat extends ProjectChatRow = ProjectChatRow,
  Member extends ProjectWorkerRow = ProjectWorkerRow,
> {
  readonly scope: ProjectChatViewScope;
  /** Only a completed coherent snapshot may establish absence of the group. */
  readonly complete: boolean;
  readonly chats: readonly Chat[];
  readonly members: readonly Member[];
}

export interface ProjectWorkerChatGroup<
  Chat extends ProjectChatRow,
  Member extends ProjectWorkerRow,
> {
  readonly workerProfileId: string;
  /** Missing membership does not erase a previously authorized private chat. */
  readonly membership: Member | null;
  readonly chats: readonly Chat[];
}

export type ProjectChatPresentation<Chat extends ProjectChatRow, Member extends ProjectWorkerRow> =
  | {
      readonly status: "unselected" | "loading";
      readonly group: null;
      readonly workers: readonly [];
    }
  | {
      readonly status: "inconsistent";
      readonly reason:
        | "duplicate-chat"
        | "duplicate-thread"
        | "multiple-groups"
        | "invalid-chat"
        | "duplicate-membership"
        | "wrong-group";
      readonly group: null;
      readonly workers: readonly [];
    }
  | {
      readonly status: "ready";
      /** Null requests the existing ensure command; reading never creates it. */
      readonly group: Chat | null;
      readonly workers: readonly ProjectWorkerChatGroup<Chat, Member>[];
    };

function sameScope(left: ProjectChatViewScope, right: ProjectChatViewScope): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.userId === right.userId &&
    left.generation === right.generation &&
    left.projectId === right.projectId
  );
}

function belongsToSelection(
  record: {
    readonly project_id: string;
    readonly owner_user_id: string;
    readonly is_deleted?: boolean;
  },
  selection: ProjectChatViewScope,
): boolean {
  return (
    record.is_deleted !== true &&
    record.project_id === selection.projectId &&
    record.owner_user_id === selection.userId
  );
}

function compareCreated(
  left: { readonly created_at_ms: number; readonly id: string },
  right: { readonly created_at_ms: number; readonly id: string },
): number {
  // Activity, display names and model changes must not reshuffle worker groups.
  return (
    left.created_at_ms - right.created_at_ms ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/**
 * One selected project's group and private chats, grouped by the native profile
 * ID. Preserves the original rows and native thread IDs; never maps them to Code
 * thread IDs, joins transcripts or infers identity from names/models/parents.
 *
 * This is a presentation safeguard, not authorization. Its input must already
 * have passed native query policy. Incomplete/retired snapshots render no rows
 * and cannot trigger an automatic group creation based on apparent absence.
 */
export function presentProjectChats<Chat extends ProjectChatRow, Member extends ProjectWorkerRow>(
  selection: ProjectChatViewScope | null,
  snapshot: ProjectChatSnapshot<Chat, Member> | null,
): ProjectChatPresentation<Chat, Member> {
  if (selection === null) return { status: "unselected", group: null, workers: [] };
  if (snapshot === null || !snapshot.complete || !sameScope(selection, snapshot.scope)) {
    return { status: "loading", group: null, workers: [] };
  }

  const inconsistent = (
    reason: Extract<ProjectChatPresentation<Chat, Member>, { status: "inconsistent" }>["reason"],
  ): ProjectChatPresentation<Chat, Member> => ({
    status: "inconsistent",
    reason,
    group: null,
    workers: [],
  });

  const chats = snapshot.chats
    .filter((chat) => belongsToSelection(chat, selection))
    .toSorted(compareCreated);
  const members = snapshot.members
    .filter((member) => belongsToSelection(member, selection))
    .toSorted(compareCreated);
  const chatIds = new Set<string>();
  const threadIds = new Set<string>();
  let group: Chat | null = null;
  for (const chat of chats) {
    if (chatIds.has(chat.id)) return inconsistent("duplicate-chat");
    if (threadIds.has(chat.thread_id)) return inconsistent("duplicate-thread");
    chatIds.add(chat.id);
    threadIds.add(chat.thread_id);
    if (chat.kind === "group") {
      if (!chat.initial || chat.worker_profile_id) return inconsistent("invalid-chat");
      if (group !== null) return inconsistent("multiple-groups");
      group = chat;
    } else if (!chat.worker_profile_id) {
      return inconsistent("invalid-chat");
    }
  }

  const workers = new Map<
    string,
    {
      workerProfileId: string;
      membership: Member | null;
      chats: Chat[];
    }
  >();
  const memberIds = new Set<string>();
  for (const member of members) {
    if (memberIds.has(member.id) || workers.has(member.worker_profile_id)) {
      return inconsistent("duplicate-membership");
    }
    memberIds.add(member.id);
    if (group !== null && member.group_chat_id !== group.id) return inconsistent("wrong-group");
    workers.set(member.worker_profile_id, {
      workerProfileId: member.worker_profile_id,
      membership: member,
      chats: [],
    });
  }
  for (const chat of chats) {
    if (chat.kind !== "private") continue;
    const workerProfileId = chat.worker_profile_id!;
    let worker = workers.get(workerProfileId);
    if (worker === undefined) {
      worker = { workerProfileId, membership: null, chats: [] };
      workers.set(workerProfileId, worker);
    }
    worker.chats.push(chat);
  }

  return {
    status: "ready",
    group,
    workers: [...workers.values()].filter(
      (worker) => worker.membership?.status === "active" || worker.chats.length > 0,
    ),
  };
}
