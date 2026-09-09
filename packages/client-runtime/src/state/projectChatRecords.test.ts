import { describe, expect, it } from "vite-plus/test";
import { decodeProjectChatRecords } from "./projectChatRecords.ts";
import { presentProjectChats } from "./projectChats.ts";

const scope = { instanceId: "instance", userId: "owner", generation: "1", projectId: "project" };
const group = {
  id: "group",
  thread_id: "group-thread",
  project_id: "project",
  owner_user_id: "owner",
  kind: "group",
  initial: true,
  created_at_ms: 1,
  updated_at_ms: 1,
};
const chat = {
  ...group,
  id: "chat",
  thread_id: "private-thread",
  kind: "private",
  initial: true,
  worker_profile_id: "worker",
};
const member = {
  id: "member",
  project_id: "project",
  owner_user_id: "owner",
  group_chat_id: "group",
  worker_profile_id: "worker",
  status: "active",
  created_at_ms: 1,
  updated_at_ms: 1,
};
const record = <T extends { id: string }>(document: T) => ({ documentId: document.id, document });

describe("native project chat record decoding", () => {
  it("feeds validated original native identities to the existing selector", () => {
    const decoded = decodeProjectChatRecords(
      scope,
      [record(group), record(chat)],
      [record(member)],
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") throw new Error("Expected valid records");
    const view = presentProjectChats(scope, { scope, complete: true, ...decoded });
    expect(view.status).toBe("ready");
    expect(view.workers[0]?.chats[0]?.thread_id).toBe("private-thread");
  });
  it("rejects a whole view on mismatched envelope IDs or another owner/project", () => {
    for (const bad of [
      { ...record(chat), documentId: "different" },
      record({ ...chat, owner_user_id: "someone-else" }),
      record({ ...chat, project_id: "other-project" }),
      record({ ...chat, owner_user_id: "someone-else", is_deleted: true }),
    ]) {
      expect(decodeProjectChatRecords(scope, [record(group), bad], [record(member)])).toEqual({
        status: "invalid",
        chats: [],
        members: [],
      });
    }
    expect(
      decodeProjectChatRecords(
        scope,
        [record(group)],
        [record({ ...member, project_id: "other-project" })],
      ).status,
    ).toBe("invalid");
  });
  it("rejects malformed fields, missing source timestamps and invalid native identifiers", () => {
    for (const change of [
      { initial: "true" },
      { kind: "unknown" },
      { worker_profile_id: undefined },
      { thread_id: "" },
      { thread_id: " x " },
      { project_id: "p".repeat(129) },
      { created_at_ms: Infinity },
      { updated_at_ms: undefined },
    ])
      expect(decodeProjectChatRecords(scope, [record({ ...chat, ...change })], []).status).toBe(
        "invalid",
      );
    expect(
      decodeProjectChatRecords(scope, [record({ ...group, worker_profile_id: "worker" })], [])
        .status,
    ).toBe("invalid");
    expect(decodeProjectChatRecords({ ...scope, generation: "" }, [], []).status).toBe("invalid");
  });
  it("rejects duplicate document identities before the selector", () => {
    expect(decodeProjectChatRecords(scope, [record(chat), record(chat)], []).status).toBe(
      "invalid",
    );
    expect(decodeProjectChatRecords(scope, [], [record(member), record(member)]).status).toBe(
      "invalid",
    );
  });
  it("projects only declared fields and preserves tombstones without sharing input objects", () => {
    const source = {
      ...chat,
      is_deleted: true,
      private_memory: "never render",
      messages: ["private"],
    };
    const decoded = decodeProjectChatRecords(scope, [record(source)], []);
    expect(decoded.status).toBe("valid");
    expect(decoded.chats[0]).not.toHaveProperty("private_memory");
    expect(decoded.chats[0]).not.toHaveProperty("messages");
    source.owner_user_id = "changed";
    expect(decoded.chats[0]?.owner_user_id).toBe("owner");
    expect(decoded.chats[0]?.is_deleted).toBe(true);
  });
});
