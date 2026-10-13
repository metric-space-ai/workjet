import { useState, useSyncExternalStore } from "react";
import type { CtoxManagedInstance } from "@workjet/contracts";

import {
  closeInstanceSetup,
  instanceSetupStore,
  isInstancesPageRequest,
  requestInstanceAdd,
  type InstanceAddOption,
  type InstanceSetupRequest,
} from "../../instanceSetup";
import { decodeBusinessOsManualCredential } from "../settings/businessOsManualCredential";
import { expandWorkjetPairingInvite } from "../settings/businessOsPairing";
import { Button } from "../ui/button";
import { Field, FieldLabel } from "../ui/field";
import { InlinePanel } from "../ui/inline-panel";
import { Input } from "../ui/input";
import { Row } from "../ui/row";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { getCtoxManagedState, useCtoxMode } from "./CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "./ctoxInstanceDisplayTitle";
import { InstanceQrScanner } from "./InstanceQrScanner";

/**
 * „Instanz hinzufügen“ als Inline-Panel auf Einstellungen › Instanzen
 * (drei Orte, keine Popups). Ein Segment oben, darunter nur die Felder der
 * gewählten Option. Importiert wird erst nach „Hinzufügen“, auch wenn ein
 * workjet://pair-Link den Einladungslink vorbelegt hat.
 */
export const INSTANCE_ADD_OPTIONS: ReadonlyArray<{
  readonly value: InstanceAddOption;
  readonly label: string;
}> = [
  { value: "ctox-dev", label: "ctox.dev" },
  { value: "link", label: "Einladungslink" },
  { value: "qr", label: "QR-Code" },
  { value: "manual", label: "Verbindungsdaten" },
];

/** Segment: die gewählte Option ist deutlich hervorgehoben. */
export const SEGMENT_TOGGLE_CLASS =
  "text-muted-foreground data-pressed:bg-primary/15 data-pressed:text-foreground dark:data-pressed:bg-primary/20";

export const INSTANCE_ADD_TRIGGER_LABEL = "Instanz hinzufügen";

const MANUAL_TOKEN = /workjet-join-v1\.[A-Za-z0-9+/=_-]+/u;

/**
 * Ein Einfügefeld: die kopierten Verbindungsdaten tragen Server und Raum im
 * Passwort selbst. Geprüft wird ausschließlich über
 * decodeBusinessOsManualCredential.
 */
export function parseManualConnectionPaste(
  text: string,
  displayName = "",
): ReturnType<typeof decodeBusinessOsManualCredential> {
  const token = MANUAL_TOKEN.exec(text)?.[0];
  if (token === undefined) throw new Error("Keine Verbindungsdaten erkannt.");
  let room = "";
  let signalingUrls = "";
  try {
    const bytes = Uint8Array.from(atob(token.slice("workjet-join-v1.".length)), (character) =>
      character.charCodeAt(0),
    );
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as { room?: unknown; signalingUrls?: unknown };
      if (typeof record.room === "string") room = record.room;
      if (Array.isArray(record.signalingUrls))
        signalingUrls = record.signalingUrls.filter((url) => typeof url === "string").join("\n");
    }
  } catch {
    throw new Error("Verbindungsdaten ungültig.");
  }
  try {
    return decodeBusinessOsManualCredential({ displayName, room, signalingUrls, password: token });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    throw new Error(
      message.includes("abgelaufen")
        ? "Verbindungsdaten abgelaufen."
        : "Verbindungsdaten ungültig.",
      { cause: cause },
    );
  }
}
export const INSTANCE_REPAIR_LABEL = "Neu koppeln";

function useInstanceSetupRequest(): InstanceSetupRequest | null {
  const request = useSyncExternalStore(
    instanceSetupStore.subscribe,
    instanceSetupStore.getSnapshot,
    () => null,
  );
  return isInstancesPageRequest(request) ? request : null;
}

export function InstanceAddInline({ className }: { readonly className?: string }) {
  const request = useInstanceSetupRequest();
  if (request === null) {
    return (
      <InlinePanel
        {...(className === undefined ? {} : { className })}
        triggerLabel={INSTANCE_ADD_TRIGGER_LABEL}
        open={false}
        onOpenChange={(open) => {
          if (open) requestInstanceAdd("ctox-dev", {}, "choose");
        }}
        submitLabel="Hinzufügen"
        onSubmit={() => undefined}
      >
        {null}
      </InlinePanel>
    );
  }
  return <InstanceAddPanel key={request.revision} className={className} request={request} />;
}

function RemovedManagedInstances({
  instances,
  busy,
  onRestore,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly busy: boolean;
  readonly onRestore: (instance: CtoxManagedInstance) => void;
}) {
  if (instances.length === 0) return null;
  return (
    <ul aria-label="Entfernte ctox.dev-Instanzen" className="divide-y divide-border/60">
      {instances.map((instance) => (
        <li key={instance.id}>
          <Row
            className="px-0"
            name={ctoxInstanceDisplayTitle(instance)}
            meta={instance.domain ?? "ctox.dev"}
            chips={
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => onRestore(instance)}
              >
                Wieder hinzufügen
              </Button>
            }
          />
        </li>
      ))}
    </ul>
  );
}

export function InstanceAddPanel({
  request,
  className,
}: {
  readonly request: InstanceSetupRequest;
  readonly className?: string | undefined;
}) {
  const mode = useCtoxMode();
  const [option, setOption] = useState<InstanceAddOption>(request.option);
  const [invite, setInvite] = useState(request.invite ?? "");
  const [displayName, setDisplayName] = useState("");
  const [connectionData, setConnectionData] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [scanRevision, setScanRevision] = useState(0);
  const replacesInstanceId = request.replacesInstanceId;
  const managedState = getCtoxManagedState(mode.discovery);
  const removedManaged =
    mode.discovery !== "loading" && mode.discovery._tag === "ready"
      ? mode.discovery.instances.filter(
          (instance) => instance.source === "ctox_dev" && instance.workjetState === "removed",
        )
      : [];

  const choose = (next: InstanceAddOption) => {
    setOption(next);
    setStatus(null);
    if (next === "qr") setScanRevision((value) => value + 1);
  };

  const finish = (outcome: { readonly ok: boolean; readonly message: string }) => {
    if (outcome.ok) {
      closeInstanceSetup();
      return;
    }
    setStatus({ text: outcome.message, error: true });
  };

  const run = (task: () => Promise<{ readonly ok: boolean; readonly message: string }>) => {
    setSubmitting(true);
    setStatus(null);
    void task()
      .then(finish, () =>
        setStatus({ text: "Instanz konnte nicht hinzugefügt werden.", error: true }),
      )
      .finally(() => setSubmitting(false));
  };

  const submit = () => {
    if (option === "ctox-dev") {
      mode.login();
      setStatus({ text: "Anmeldung im Browser geöffnet.", error: false });
      return;
    }
    if (option === "link") {
      run(() => mode.importInvite(expandWorkjetPairingInvite(invite), replacesInstanceId));
      return;
    }
    if (option === "manual") {
      let input: ReturnType<typeof decodeBusinessOsManualCredential>;
      try {
        input = parseManualConnectionPaste(connectionData, displayName);
      } catch (cause) {
        setStatus({
          text: cause instanceof Error ? cause.message : "Verbindungsdaten ungültig.",
          error: true,
        });
        return;
      }
      run(() =>
        mode.importManualPairing({
          ...input,
          ...(replacesInstanceId === undefined ? {} : { replacesInstanceId }),
        }),
      );
    }
  };

  const restore = (instance: CtoxManagedInstance) =>
    run(async () => {
      const outcome = await mode.setInstanceState(instance, "enabled");
      return outcome.ok
        ? outcome
        : { ok: false, message: "Instanz konnte nicht wiederhergestellt werden." };
    });

  const submitLabel = option === "ctox-dev" ? "Bei ctox.dev anmelden" : "Hinzufügen";
  const submitDisabled =
    option === "qr" ||
    (option === "link" && invite.trim() === "") ||
    (option === "manual" && connectionData.trim() === "") ||
    (option === "ctox-dev" && (mode.bridge === undefined || mode.refreshing));
  const statusLine =
    status ??
    (option === "ctox-dev" && managedState === "ready" && mode.bridge !== undefined
      ? { text: "Bei ctox.dev angemeldet.", error: false }
      : null);

  return (
    <InlinePanel
      {...(className === undefined ? {} : { className })}
      triggerLabel={
        replacesInstanceId === undefined ? INSTANCE_ADD_TRIGGER_LABEL : INSTANCE_REPAIR_LABEL
      }
      open
      onOpenChange={(open) => {
        if (!open && !submitting) closeInstanceSetup();
      }}
      segment={
        <ToggleGroup
          aria-label="Art der Verbindung"
          className="flex-wrap"
          size="sm"
          variant="outline"
          value={[option]}
          onValueChange={(value) => {
            const next = INSTANCE_ADD_OPTIONS.find((entry) => entry.value === value[0]);
            if (next !== undefined && !submitting) choose(next.value);
          }}
        >
          {INSTANCE_ADD_OPTIONS.map((entry) => (
            <Toggle
              key={entry.value}
              value={entry.value}
              disabled={submitting}
              data-workjet-instance-add-option={entry.value}
              className={SEGMENT_TOGGLE_CLASS}
            >
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
      }
      submitLabel={submitLabel}
      onSubmit={submit}
      submitDisabled={submitDisabled}
      busy={submitting}
      {...(statusLine === null
        ? {}
        : {
            status: statusLine.text,
            statusTone: statusLine.error ? ("error" as const) : ("neutral" as const),
          })}
    >
      {option === "ctox-dev" ? (
        <>
          <div>
            <Button
              size="sm"
              variant="outline"
              render={<a href="https://ctox.dev" target="_blank" rel="noopener noreferrer" />}
            >
              ctox.dev öffnen
            </Button>
          </div>
          <RemovedManagedInstances
            instances={removedManaged}
            busy={submitting}
            onRestore={restore}
          />
        </>
      ) : null}
      {option === "link" ? (
        <Field>
          <FieldLabel>Einladungslink</FieldLabel>
          <Textarea
            autoComplete="off"
            className="font-mono text-xs"
            maxLength={65_536}
            placeholder="workjet://pair?payload=…"
            rows={3}
            spellCheck={false}
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
          />
        </Field>
      ) : null}
      {option === "qr" ? (
        <InstanceQrScanner
          key={scanRevision}
          onDetected={(value) => {
            setInvite(value);
            setOption("link");
            setStatus({ text: "QR-Code erkannt.", error: false });
          }}
          onUnavailable={(message) => {
            setOption("link");
            setStatus({ text: message, error: true });
          }}
        />
      ) : null}
      {option === "manual" ? (
        <div className="grid gap-3">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              autoComplete="off"
              maxLength={256}
              size="sm"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Verbindungsdaten</FieldLabel>
            <Textarea
              autoComplete="off"
              className="font-mono text-xs"
              maxLength={200_000}
              placeholder="workjet-join-v1.…"
              rows={3}
              spellCheck={false}
              value={connectionData}
              onChange={(event) => setConnectionData(event.target.value)}
            />
          </Field>
        </div>
      ) : null}
    </InlinePanel>
  );
}
