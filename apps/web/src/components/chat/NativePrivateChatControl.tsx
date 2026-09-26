import { useEffect, useRef, useState } from "react";
import {
  CommandId,
  type WorkjetThreadConfig,
  type WorkjetThreadCtoxCrewChat,
} from "@workjet/contracts";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { randomUUID } from "../../lib/utils";
import {
  createWorkjetPrivateChat,
  privateChatIntentRequest,
  type WorkjetPrivateChatIntent,
  type PrivateChatCreationRequest,
} from "../../workjetPrivateChat";

export function NativePrivateChatControl(props: {
  readonly instanceId: string;
  readonly connectionId: WorkjetThreadCtoxCrewChat["connectionId"] | null;
  readonly connections: readonly {
    readonly connectionId: WorkjetThreadCtoxCrewChat["connectionId"];
    readonly label: string;
  }[];
  readonly onSelectConnection: (id: string) => void;
  readonly projectId: PrivateChatCreationRequest["projectId"];
  readonly workerId: string;
  readonly config: WorkjetThreadConfig;
  readonly prepareIntent: (candidate: WorkjetPrivateChatIntent) => WorkjetPrivateChatIntent;
  readonly isScopeCurrent: () => boolean;
  readonly onBound: (chat: WorkjetThreadCtoxCrewChat) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const live = useRef(true);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const open = async (separate: boolean) => {
    if (pending.current || props.connectionId === null) return;
    const captured = props;
    const isCurrent = () =>
      live.current &&
      captured.isScopeCurrent() &&
      current.current.instanceId === captured.instanceId &&
      current.current.connectionId === captured.connectionId &&
      current.current.projectId === captured.projectId &&
      current.current.workerId === captured.workerId &&
      current.current.config === captured.config;

    pending.current = true;
    setBusy(true);
    try {
      if (!isCurrent()) throw new Error("The selected project changed. Reopen its draft.");
      // Synchronously persist before any native request; rehydrated retries reuse both IDs.
      const intent = captured.prepareIntent({
        instanceId: captured.instanceId,
        connectionId: captured.connectionId!,
        projectId: captured.projectId,
        workerProfileId: captured.workerId,
        separate,
        membershipCommandId: CommandId.make(randomUUID()),
        chatCommandId: CommandId.make(randomUUID()),
        createdAt: new Date().toISOString(),
      });
      const scope = {
        instanceId: captured.instanceId,
        connectionId: captured.connectionId!,
        isCurrent,
      };
      const first = await createWorkjetPrivateChat({
        ...scope,
        request: privateChatIntentRequest(intent, "project.worker.add"),
      });
      const chat = separate
        ? await createWorkjetPrivateChat({
            ...scope,
            request: privateChatIntentRequest(intent, "project.chat.create"),
          })
        : first;
      if (isCurrent()) captured.onBound(chat);
    } catch (error) {
      if (live.current)
        toastManager.add({
          type: "error",
          title: "Could not open the worker chat",
          description: error instanceof Error ? error.message : "CTOX did not confirm the chat.",
        });
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select
        aria-label="Private chat connection"
        value={props.connectionId ?? ""}
        disabled={busy}
        onChange={(event) => props.onSelectConnection(event.target.value)}
        className="max-w-48 rounded border bg-background px-2 py-1 text-xs"
      >
        <option value="">Choose connection</option>
        {props.connections.map((connection) => (
          <option key={connection.connectionId} value={connection.connectionId}>
            {connection.label}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || props.connectionId === null}
        onClick={() => void open(false)}
      >
        {busy ? "Opening…" : "Open worker chat"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || props.connectionId === null}
        onClick={() => void open(true)}
      >
        New private chat
      </Button>
      {props.connectionId === null ? (
        <span className="text-xs text-muted-foreground">Choose a ready CTOX connection.</span>
      ) : null}
    </div>
  );
}
