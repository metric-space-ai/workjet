import type {
  CtoxWorkjetProjectControlRequest,
  WorkjetThreadCtoxCrewChat,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { normalizeWorkjetThreadConfig } from "@workjet/contracts";
import type { WorkjetPrivateChatIntent } from "./workjetPrivateChatIntent";
export { WorkjetPrivateChatIntent, samePrivateChatIntentScope } from "./workjetPrivateChatIntent";

import {
  requestWorkjetProjectControlFromExplicitHost,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

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
  if (!input.isCurrent()) throw new Error("Projekt nicht mehr aktiv.");
  const result = await requestWorkjetProjectControlFromExplicitHost(
    input.instanceId,
    input.request,
    input.port,
  );
  if (!input.isCurrent()) throw new Error("Projekt wurde zwischenzeitlich gewechselt.");
  if (result._tag !== "completed") throw new Error("CTOX hat den Chat nicht bestätigt.");
  const response = result.response;
  if (
    (response.action !== "project.worker.add" && response.action !== "project.chat.create") ||
    response.action !== input.request.action ||
    response.commandId !== input.request.commandId ||
    response.projectId !== input.request.projectId ||
    response.workerProfileId !== input.request.workerProfileId ||
    !/^workjet_private_.+/.test(response.chatId)
  )
    throw new Error("CTOX meldet einen anderen Chat.");
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
    throw new Error("Neue Unterhaltung für anderen Chat öffnen.");
  }
  return { ...normalized, ctoxCrewChat: chat };
}
