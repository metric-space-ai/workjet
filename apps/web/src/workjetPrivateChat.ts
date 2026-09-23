import type {
  CtoxWorkjetProjectControlRequest,
  WorkjetThreadCtoxCrewChat,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { normalizeWorkjetThreadConfig } from "@workjet/contracts";
import { CommandId, ProjectId, WorkjetConnectionId, IsoDateTime } from "@workjet/contracts";
import * as Schema from "effect/Schema";

import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

// Draft-owned write-ahead intent also retains project ownership after binding.
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

export function privateChatIntentRequest(
  intent: WorkjetPrivateChatIntent,
  action: PrivateChatCreationRequest["action"],
): PrivateChatCreationRequest {
  const common = {
    projectId: intent.projectId,
    workerProfileId: intent.workerProfileId,
    createdAt: intent.createdAt,
  };
  return action === "project.worker.add"
    ? { ...common, action, commandId: intent.membershipCommandId }
    : { ...common, action, commandId: intent.chatCommandId, title: "Chat" };
}

export type PrivateChatCreationRequest = Extract<
  CtoxWorkjetProjectControlRequest,
  { readonly action: "project.worker.add" | "project.chat.create" }
>;

/** The caller captures the confirmed instance/connection and selection generation.
 * No local ID is created, and a late response cannot bind a different selection.
 */
export async function createWorkjetPrivateChat(input: {
  readonly instanceId: string;
  readonly connectionId: WorkjetThreadCtoxCrewChat["connectionId"];
  readonly request: PrivateChatCreationRequest;
  readonly isCurrent: () => boolean;
  readonly port?: WorkjetProjectControlPort;
}): Promise<WorkjetThreadCtoxCrewChat> {
  if (!input.isCurrent()) throw new Error("The selected project is no longer active.");
  const result = await requestWorkjetProjectControl(input.instanceId, input.request, input.port);
  if (!input.isCurrent()) throw new Error("The selected project changed while creating the chat.");
  if (result._tag !== "completed") throw new Error("CTOX did not confirm the private chat.");
  const response = result.response;
  if (
    (response.action !== "project.worker.add" && response.action !== "project.chat.create") ||
    response.action !== input.request.action ||
    response.commandId !== input.request.commandId ||
    response.projectId !== input.request.projectId ||
    response.workerProfileId !== input.request.workerProfileId ||
    !/^workjet_private_.+/.test(response.chatId)
  )
    throw new Error("CTOX returned a different private chat request.");
  return {
    instanceId: input.instanceId,
    connectionId: input.connectionId,
    chatId: response.chatId,
  };
}

/** Store through the existing draft/thread config, whose schema also hydrates it. */
export function bindWorkjetPrivateChat(
  config: WorkjetThreadConfig,
  chat: WorkjetThreadCtoxCrewChat,
): WorkjetThreadConfig {
  const normalized = normalizeWorkjetThreadConfig(config);
  if (
    normalized.ctoxCrewChat !== undefined &&
    (normalized.ctoxCrewChat.chatId !== chat.chatId ||
      normalized.ctoxCrewChat.instanceId !== chat.instanceId ||
      normalized.ctoxCrewChat.connectionId !== chat.connectionId)
  ) {
    throw new Error("Open a new thread for a different private chat.");
  }
  return { ...normalized, ctoxCrewChat: chat };
}
