import { useCtoxCommand } from "./hooks";

/** Native human-chat operations. Creating a message does not claim to start a Supervisor/model turn. */
export function useCtoxThreadCommands(instanceId: string | null, threadId: string | null) {
  const controls = useCtoxCommand(instanceId);
  const dispatch = (type: string, payload: object) => {
    if (threadId === null || !threadId.trim()) throw new Error("ctox_thread_unavailable");
    return controls.command(type, payload, { record_id: threadId });
  };
  return {
    ...controls,
    createMessage: (body: string) => dispatch("threads.message.create", { body }),
    archive: () => dispatch("threads.thread.archive", {}),
    updateState: (patch: {
      pinned?: boolean;
      last_seen_at_ms?: number;
      snoozed_until_ms?: number | null;
      follow_up_at_ms?: number | null;
      priority?: "low" | "normal" | "high" | "urgent";
    }) => dispatch("threads.thread.state.update", patch),
  };
}
