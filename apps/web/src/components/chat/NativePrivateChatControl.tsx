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
  // Retain command IDs after ambiguous failures so a retry cannot create another chat.
  const attempts = useRef(new Map<string, PrivateChatCreationRequest>());
  const open = async (separate: boolean) => {
    if (pending.current || props.connectionId === null) return;
    const captured = props;
    const isCurrent = () =>
      live.current &&
      current.current.instanceId === captured.instanceId &&
      current.current.connectionId === captured.connectionId &&
      current.current.projectId === captured.projectId &&
      current.current.workerId === captured.workerId &&
      current.current.config === captured.config;
    const request = (action: PrivateChatCreationRequest["action"]): PrivateChatCreationRequest => {
      const key = JSON.stringify([
        captured.instanceId,
        captured.connectionId,
        captured.projectId,
        captured.workerId,
        action,
      ]);
      const existing = attempts.current.get(key);
      if (existing) return existing;
      const common = {
        commandId: CommandId.make(randomUUID()),
        projectId: captured.projectId,
        workerProfileId: captured.workerId,
        createdAt: new Date().toISOString(),
      };
      const value: PrivateChatCreationRequest =
        action === "project.chat.create"
          ? { ...common, action, title: "Chat" }
          : { ...common, action };
      attempts.current.set(key, value);
      return value;
    };
    pending.current = true;
    setBusy(true);
    try {
      const scope = {
        instanceId: captured.instanceId,
        connectionId: captured.connectionId!,
        isCurrent,
      };
      const first = await createWorkjetPrivateChat({
        ...scope,
        request: request("project.worker.add"),
      });
      const chat = separate
        ? await createWorkjetPrivateChat({ ...scope, request: request("project.chat.create") })
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
