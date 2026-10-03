import { describe, expect, it } from "vite-plus/test";
import {
  presentProjectChats,
  type ProjectChatRow,
  type ProjectChatSnapshot,
  type ProjectChatViewScope,
  type ProjectWorkerRow,
} from "./projectChats.ts";

const scope: ProjectChatViewScope = {
  instanceId: "instance-a",
  userId: "owner",
  generation: "connection-1",
  projectId: "project",
};
function chat(id: string, worker: string | null, created = 1): ProjectChatRow & { title: string } {
  return {
    id,
    thread_id: `native-${id}`,
    project_id: scope.projectId,
    owner_user_id: scope.userId,
    kind: worker === null ? "group" : "private",
    ...(worker === null ? {} : { worker_profile_id: worker }),
    initial: true,
    created_at_ms: created,
    title: "Same display name",
  };
}
function member(worker: string, created = 1): ProjectWorkerRow {
  return {
    id: `member-${worker}`,
    project_id: scope.projectId,
    owner_user_id: scope.userId,
    group_chat_id: "group",
    worker_profile_id: worker,
    status: "active",
    created_at_ms: created,
  };
}
const group = chat("group", null);
const first = chat("first", "worker-a");
const second = { ...chat("second", "worker-a", 2), initial: false };
const other = chat("other", "worker-b");
function snapshot(
  chats: readonly ProjectChatRow[] = [group, first, second, other],
  members: readonly ProjectWorkerRow[] = [member("worker-a"), member("worker-b", 2)],
): ProjectChatSnapshot {
  return { scope, complete: true, chats, members };
}

describe("project chat presentation", () => {
  it("presents one group and separate native conversations under stable worker IDs", () => {
    const result = presentProjectChats(scope, snapshot());
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.group).toBe(group);
    expect(
      result.workers.map((worker) => [worker.workerProfileId, worker.chats.map((row) => row.id)]),
    ).toEqual([
      ["worker-a", ["first", "second"]],
      ["worker-b", ["other"]],
    ]);
    expect(result.workers[0]!.chats[1]).toBe(second);
    expect(result.workers[0]!.chats[1]!.thread_id).toBe("native-second");
  });

  it("does not merge identical names or regroup a renamed profile", () => {
    const before = presentProjectChats(scope, snapshot());
    const renamed = snapshot().chats.map((row) => ({ ...row, title: "Renamed worker" }));
    const after = presentProjectChats(scope, snapshot(renamed));
    expect(after.workers.map((worker) => worker.workerProfileId)).toEqual(
      before.workers.map((worker) => worker.workerProfileId),
    );
  });

  it("retains multiple chat histories after a worker is removed and re-added", () => {
    const removed = snapshot(
      [group, first, second],
      [{ ...member("worker-a"), status: "removed" }],
    );
    const result = presentProjectChats(scope, removed);
    expect(result.status).toBe("ready");
    expect(result.workers[0]!.membership?.status).toBe("removed");
    expect(result.workers[0]!.chats).toEqual([first, second]);
    const readded = presentProjectChats(
      scope,
      snapshot([group, first, second], [member("worker-a")]),
    );
    expect(readded.workers[0]!.chats).toEqual([first, second]);
    expect(readded.workers[0]!.membership?.status).toBe("active");
  });

  it("keeps authorized history when profile membership is absent without inventing membership", () => {
    const result = presentProjectChats(scope, snapshot([group, first], []));
    expect(result.workers[0]!.membership).toBeNull();
    expect(result.workers[0]!.chats).toEqual([first]);
  });

  it("shows an active worker awaiting its first chat but omits removed workers without history", () => {
    const result = presentProjectChats(
      scope,
      snapshot([group], [member("worker-a"), { ...member("worker-b"), status: "removed" }]),
    );
    expect(result.workers.map((worker) => worker.workerProfileId)).toEqual(["worker-a"]);
    expect(result.workers[0]!.chats).toEqual([]);
  });

  it("does not infer a missing group from partial data or a different session/project", () => {
    expect(presentProjectChats(null, snapshot()).status).toBe("unselected");
    expect(presentProjectChats(scope, null).status).toBe("loading");
    expect(presentProjectChats(scope, { ...snapshot([], []), complete: false }).status).toBe(
      "loading",
    );
    for (const change of [
      { instanceId: "instance-b" },
      { userId: "another-user" },
      { generation: "connection-2" },
      { projectId: "another-project" },
    ]) {
      const result = presentProjectChats({ ...scope, ...change }, snapshot());
      expect(result).toEqual({ status: "loading", group: null, workers: [] });
    }
    expect(presentProjectChats(scope, snapshot([], []))).toEqual({
      status: "ready",
      group: null,
      workers: [],
    });
  });

  it("excludes foreign and deleted rows even when delivered in a selected snapshot", () => {
    const rows = [
      group,
      first,
      { ...second, owner_user_id: "other-user" },
      { ...other, project_id: "other-project" },
      { ...chat("deleted", "worker-c"), is_deleted: true },
    ];
    const memberships = [
      member("worker-a"),
      { ...member("worker-b"), project_id: "other-project" },
      { ...member("worker-c"), owner_user_id: "other-user" },
      { ...member("worker-d"), is_deleted: true },
    ];
    const result = presentProjectChats(scope, snapshot(rows, memberships));
    expect(result.workers.map((worker) => worker.workerProfileId)).toEqual(["worker-a"]);
    expect(result.workers[0]!.chats).toEqual([first]);
  });

  it("keeps stable order across shuffled pages and preserves independent chat objects", () => {
    const source = snapshot(
      [other, second, group, first],
      [member("worker-b", 2), member("worker-a")],
    );
    const result = presentProjectChats(scope, source);
    expect(result.workers.map((worker) => worker.workerProfileId)).toEqual([
      "worker-a",
      "worker-b",
    ]);
    expect(result.workers[0]!.chats).toEqual([first, second]);
    expect(source.chats).toEqual([other, second, group, first]);
  });

  it.each([
    ["duplicate-chat", [group, first, { ...first, thread_id: "different" }]],
    ["duplicate-thread", [group, first, { ...second, thread_id: first.thread_id }]],
    ["multiple-groups", [group, chat("other-group", null)]],
    ["invalid-chat", [group, { ...first, worker_profile_id: "" }]],
    ["invalid-chat", [{ ...group, initial: false }]],
    ["invalid-chat", [{ ...group, worker_profile_id: "worker-a" }]],
  ] as const)("does not silently choose rows for inconsistent %s", (reason, chats) => {
    expect(presentProjectChats(scope, snapshot(chats, []))).toEqual({
      status: "inconsistent",
      reason,
      group: null,
      workers: [],
    });
  });

  it("rejects conflicting memberships and memberships belonging to another group", () => {
    expect(
      presentProjectChats(
        scope,
        snapshot([group], [member("worker-a"), { ...member("worker-a"), id: "duplicate-profile" }]),
      ).status,
    ).toBe("inconsistent");
    expect(
      presentProjectChats(
        scope,
        snapshot([group], [{ ...member("worker-a"), group_chat_id: "foreign-group" }]),
      ),
    ).toEqual({ status: "inconsistent", reason: "wrong-group", group: null, workers: [] });
  });
});
