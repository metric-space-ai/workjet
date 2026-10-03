import { describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  WorkjetComputerId,
  ProjectId,
  WorkjetConnectionId,
  DEFAULT_WORKJET_THREAD_CONFIG,
} from "@workjet/contracts";
import {
  bindWorkjetPrivateChat,
  createWorkjetPrivateChat,
  type PrivateChatCreationRequest,
} from "./workjetPrivateChat";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";
import { resolvePrivateChatDraftProject } from "./workjetPrivateChatScope";

const request: PrivateChatCreationRequest = {
  action: "project.chat.create",
  commandId: CommandId.make("create-chat"),
  projectId: ProjectId.make("project-one"),
  workerProfileId: "worker-one",
  title: "Chat",
  createdAt: "2026-09-12T10:00:00.000Z",
};
const response = {
  action: request.action,
  commandId: request.commandId,
  projectId: request.projectId,
  workerProfileId: request.workerProfileId,
  chatId: "workjet_private_opaque_from_native",
} as const;
const scope = {
  instanceId: "instance-one",
  connectionId: WorkjetConnectionId.make("connection-one"),
  request,
  isCurrent: () => true,
};

describe("native private chat binding", () => {
  it("keeps a retained draft bound to its working-copy project when the registry selection changes", () => {
    const environmentId = EnvironmentId.make("remote");
    const computer = {
      id: WorkjetComputerId.make("remote-computer"),
      label: "Remote",
      environmentId,
      presentationKind: "remote" as const,
      harnesses: [],
    };
    const first = {
      id: ProjectId.make("native-one"),
      title: "First",
      workingCopies: [
        {
          id: "copy-one",
          computerId: computer.id,
          path: "/projects/one",
          status: "active" as const,
        },
      ],
    };
    const second = {
      id: ProjectId.make("native-two"),
      title: "Second",
      workingCopies: [
        {
          id: "copy-two",
          computerId: computer.id,
          path: "/projects/two",
          status: "active" as const,
        },
      ],
    };
    const registry = {
      presentationInstanceId: "instance-one",
      phase: "ready" as const,
      projects: [first, second],
      selectedProjectId: first.id,
    };
    const draft = {
      environmentId,
      projectId: ProjectId.make("local-one"),
      worktreePath: "/projects/one",
    };
    const input = { registry, draft, computers: [computer] };
    expect(resolvePrivateChatDraftProject(input)).toEqual(first);
    expect(
      resolvePrivateChatDraftProject({
        ...input,
        registry: { ...registry, selectedProjectId: second.id },
      }),
    ).toBeUndefined();
    expect(
      resolvePrivateChatDraftProject({
        ...input,
        draft: { ...draft, environmentId: EnvironmentId.make("other") },
      }),
    ).toBeUndefined();
    expect(
      resolvePrivateChatDraftProject({
        ...input,
        registry: { ...registry, projects: [first, { ...first, id: second.id }] },
      }),
    ).toBeUndefined();
  });
  it("preserves the exact native ID and creation request", async () => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "completed", response });
    const chat = await createWorkjetPrivateChat({ ...scope, port });
    expect(chat).toEqual({
      instanceId: scope.instanceId,
      connectionId: scope.connectionId,
      chatId: response.chatId,
    });
    expect(port).toHaveBeenCalledExactlyOnceWith(scope.instanceId, request);
    expect(bindWorkjetPrivateChat(DEFAULT_WORKJET_THREAD_CONFIG, chat)).toMatchObject({
      ctoxCrewChat: chat,
    });
  });
  it.each([
    { commandId: CommandId.make("other-command") },
    { projectId: ProjectId.make("other-project") },
    { workerProfileId: "other-worker" },
    { action: "project.worker.add" as const },
    { chatId: "workjet_group_not_private" },
  ])("rejects a mismatched creation response: %j", async (change) => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "completed", response: { ...response, ...change } });
    await expect(createWorkjetPrivateChat({ ...scope, port })).rejects.toThrow(
      "different private chat",
    );
  });
  it("rejects a late response after the selection changed", async () => {
    let current = true;
    const port = vi.fn<WorkjetProjectControlPort>().mockImplementation(async () => {
      current = false;
      return { _tag: "completed", response };
    });
    await expect(
      createWorkjetPrivateChat({ ...scope, port, isCurrent: () => current }),
    ).rejects.toThrow("selected project changed");
  });
  it("never replaces an existing private conversation", () => {
    const chat = {
      instanceId: scope.instanceId,
      connectionId: scope.connectionId,
      chatId: response.chatId,
    };
    const bound = bindWorkjetPrivateChat(DEFAULT_WORKJET_THREAD_CONFIG, chat);
    expect(() =>
      bindWorkjetPrivateChat(bound, { ...chat, chatId: "workjet_private_other" }),
    ).toThrow("new thread");
    expect(bindWorkjetPrivateChat(bound, chat)).toEqual(bound);
  });
});
