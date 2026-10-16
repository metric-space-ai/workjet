import type {
  CommandId,
  CtoxWorkjetProjectControlRequest,
  WorkjetThreadCtoxCrewChat,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { normalizeWorkjetThreadConfig } from "@workjet/contracts";
import type { WorkjetPrivateChatIntent } from "./workjetPrivateChatIntent";
export { WorkjetPrivateChatIntent, samePrivateChatIntentScope } from "./workjetPrivateChatIntent";

import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";
import { isCommandReceiptUncertain } from "./lib/commandAttempt";

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

/** CTOX answered; `receiptUncertain` says whether that answer was final for the ids. */
export class WorkjetPrivateChatError extends Error {
  constructor(
    message: string,
    readonly receiptUncertain: boolean,
  ) {
    super(message);
    this.name = "WorkjetPrivateChatError";
  }
}

/**
 * After a failed open: the intent to store for the next try, or null to keep
 * the saved one. Only a final CTOX answer renews both ids; a lost receipt keeps them.
 */
export function renewedPrivateChatIntent(
  error: unknown,
  intent: WorkjetPrivateChatIntent,
  fresh: () => CommandId,
): WorkjetPrivateChatIntent | null {
  return error instanceof WorkjetPrivateChatError && !error.receiptUncertain
    ? { ...intent, membershipCommandId: fresh(), chatCommandId: fresh() }
    : null;
}

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
  const result = await requestWorkjetProjectControl(input.instanceId, input.request, input.port);
  if (!input.isCurrent()) throw new Error("Projekt wurde zwischenzeitlich gewechselt.");
  if (result._tag !== "completed")
    throw new WorkjetPrivateChatError(
      "CTOX hat den Chat nicht bestätigt.",
      isCommandReceiptUncertain(result),
    );
  const response = result.response;
  if (
    (response.action !== "project.worker.add" && response.action !== "project.chat.create") ||
    response.action !== input.request.action ||
    response.commandId !== input.request.commandId ||
    response.projectId !== input.request.projectId ||
    response.workerProfileId !== input.request.workerProfileId ||
    !/^workjet_private_.+/.test(response.chatId)
  )
    throw new WorkjetPrivateChatError("CTOX meldet einen anderen Chat.", false);
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
