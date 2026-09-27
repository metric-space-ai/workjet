import { normalizeWorkjetThreadConfig, type WorkjetThreadConfig } from "./workjet.ts";

/** Disabling tools revokes access, but does not erase a thread's instance identity. */
export function retainWorkjetCtoxBinding(
  previous: WorkjetThreadConfig,
  next: WorkjetThreadConfig,
): { readonly config: WorkjetThreadConfig; readonly error: string | null } {
  const before = normalizeWorkjetThreadConfig(previous);
  const after = normalizeWorkjetThreadConfig(next);
  const original = before.capabilityBindings.find(
    (binding) => binding.capabilityId === "ctox-business-os",
  );
  const requested = after.capabilityBindings.filter(
    (binding) => binding.capabilityId === "ctox-business-os",
  );
  const binding = requested[0];
  const originalChat = before.ctoxCrewChat;
  const requestedChat = after.ctoxCrewChat;
  if (
    originalChat &&
    requestedChat &&
    (originalChat.instanceId !== requestedChat.instanceId ||
      originalChat.connectionId !== requestedChat.connectionId ||
      originalChat.chatId !== requestedChat.chatId)
  ) {
    return {
      config: next,
      error:
        "This thread keeps its original private CTOX chat. Start a new thread for another chat.",
    };
  }
  if (requested.length > 1 || (binding && !binding.target.instanceId)) {
    return { config: next, error: "CTOX Business OS requires one explicit instance binding." };
  }
  if (
    original &&
    binding &&
    (original.target.connectionId !== binding.target.connectionId ||
      original.target.instanceId !== binding.target.instanceId)
  ) {
    return {
      config: next,
      error:
        "This thread keeps its original CTOX instance. Start a new thread to use another connection.",
    };
  }
  const instanceId = original?.target.instanceId ?? binding?.target.instanceId;
  if (
    instanceId &&
    ((before.ctoxSession && before.ctoxSession.instanceId !== instanceId) ||
      (after.ctoxSession && after.ctoxSession.instanceId !== instanceId))
  ) {
    return {
      config: next,
      error: "The CTOX tool binding must match the thread's registered instance.",
    };
  }
  // A replace-all config update may omit the chat while changing unrelated
  // settings. Preserve the first private-chat identity just like the native
  // instance binding, so a later command cannot erase or retarget it.
  const retainedChat =
    originalChat && !requestedChat ? { ...after, ctoxCrewChat: originalChat } : next;
  return {
    config:
      original && !binding
        ? {
            ...normalizeWorkjetThreadConfig(retainedChat),
            capabilityBindings: [...after.capabilityBindings, original],
          }
        : retainedChat,
    error: null,
  };
}
