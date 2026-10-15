import { useEffect, useRef, useState } from "react";
import { OptionSelect } from "../ui/option-select";
import {
  CommandId,
  type WorkjetThreadConfig,
  type WorkjetThreadCtoxCrewChat,
} from "@workjet/contracts";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { randomUUID } from "../../lib/utils";
import { classifyComposerError } from "./composerErrorLineLogic";
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
      if (!isCurrent()) throw new Error("Projekt gewechselt, Entwurf neu öffnen");
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
          // Kein Rohtext im Toast: 401 heißt abgelaufener Instanz-Zugang, sonst nur die Zeile.
          title:
            classifyComposerError(error) === "authentication"
              ? "Anmeldung der Instanz abgelaufen"
              : "Preset-Chat nicht geöffnet",
        });
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <OptionSelect
        aria-label="Verbindung für privaten Chat"
        className="w-auto max-w-48"
        value={props.connectionId ?? ""}
        placeholder="Verbindung wählen"
        disabled={busy}
        options={props.connections.map((connection) => ({
          value: connection.connectionId,
          label: connection.label,
        }))}
        onValueChange={props.onSelectConnection}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || props.connectionId === null}
        onClick={() => void open(false)}
      >
        {busy ? "Wird geöffnet …" : "Preset-Chat öffnen"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || props.connectionId === null}
        onClick={() => void open(true)}
      >
        Neuer privater Chat
      </Button>
      {props.connectionId === null ? (
        <span className="text-xs text-muted-foreground">Keine Verbindung gewählt</span>
      ) : null}
    </div>
  );
}
