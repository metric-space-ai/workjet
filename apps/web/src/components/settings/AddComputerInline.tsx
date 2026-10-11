"use client";

/**
 * „Rechner hinzufügen“ als Inline-Panel auf Einstellungen › Rechner.
 * Owner: „es gibt doch drei Optionen, wie Local, SSH und Tailscale, und dann
 * noch die Haken, fertig.“ Gespeicherte SSH-Aliasse und tailnet-Geräte sind
 * anklickbar; Host-Schlüssel, Fehler und der Schlüssel zum Eintragen stehen
 * je als EINE Zeile im selben Panel. Kein Dialog, kein Zurückspringen.
 */
import type {
  ComputerFacts,
  ComputerSshKeyInfo,
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentTarget,
  DesktopTailscalePeers,
  WorkjetProvisioningTarget,
  WorkjetSshHostKeyInspectResult,
} from "@workjet/contracts";
import { CopyIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { InlinePanel } from "../ui/inline-panel";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  ComputerRoleCheckboxes,
  DEFAULT_COMPUTER_ROLES,
  gibOf,
  gpuDetected,
  shortGpuModel,
  type ComputerRoles,
} from "./ComputerCapabilitiesEditor";
import { formatDesktopSshTarget, parseManualDesktopSshTarget } from "./ConnectionsSettings";

export type AddComputerKind = "local" | "ssh" | "tailscale";

export interface AddComputerRequest {
  readonly kind: AddComputerKind;
  /** null für „Local“. */
  readonly target: DesktopSshEnvironmentTarget | null;
  readonly label: string;
  readonly roles: ComputerRoles;
  /** Bestätigter Host-Schlüssel, wenn Build oder Speicher ihn brauchen. */
  readonly hostKey: { readonly algorithm: string; readonly fingerprint: string } | null;
  /** Gewählter SSH-Schlüssel (Pfad ohne `.pub`), null bei Local. */
  readonly identityFile: string | null;
  /** true, wenn die GPU schon erkannt war und der Haken bewusst steht. */
  readonly gpuDecided: boolean;
}

/** Was Workjet über das Ziel schon weiß (aus einer früheren Erkennung). */
export interface KnownComputerFacts {
  readonly facts: ComputerFacts | null;
  readonly identityFiles: ReadonlyArray<string>;
}

export function gpuSummary(facts: ComputerFacts | null | undefined): string | null {
  const gpu = facts?.gpus[0];
  if (!facts || !gpu) return null;
  const bytes = gpu.vramBytes ?? (gpu.unifiedMemory ? facts.ramBytes : null);
  return [shortGpuModel(gpu.model), bytes ? `${gibOf(bytes)} GB` : null]
    .filter((part): part is string => !!part)
    .join(" · ");
}

function keyName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Befehl, der den gewählten öffentlichen Schlüssel auf dem Ziel einträgt. */
export function sshCopyIdCommand(
  identityFile: string,
  target: Pick<DesktopSshEnvironmentTarget, "hostname" | "username" | "port">,
): string {
  const where = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  const port = target.port && target.port !== 22 ? ` -p ${target.port}` : "";
  return `ssh-copy-id -i ${identityFile}.pub${port} ${where}`;
}

export type AddComputerOutcome =
  | { readonly status: "done" }
  | {
      readonly status: "key";
      readonly publicKey: string;
      readonly publicKeySha256: string;
      readonly where: string;
    }
  | { readonly status: "error"; readonly message: string };

type Phase =
  | { readonly kind: "form" }
  | {
      readonly kind: "hostkey";
      readonly request: AddComputerRequest;
      readonly algorithm: string;
      readonly fingerprint: string;
    }
  | { readonly kind: "running" }
  | {
      readonly kind: "key";
      readonly publicKey: string;
      readonly publicKeySha256: string;
      readonly where: string;
    };

const SEGMENTS: ReadonlyArray<{ readonly value: AddComputerKind; readonly label: string }> = [
  { value: "local", label: "Local" },
  { value: "ssh", label: "SSH" },
  { value: "tailscale", label: "Tailscale" },
];

function provisioningTarget(target: DesktopSshEnvironmentTarget): WorkjetProvisioningTarget {
  return {
    _tag: "ssh",
    ssh: {
      alias: target.alias,
      hostname: target.hostname,
      username: target.username,
      port: target.port ?? 22,
    },
  };
}

function TailscalePeerChoices({
  discover,
  selected,
  disabled,
  onSelect,
}: {
  readonly discover: (() => Promise<DesktopTailscalePeers>) | undefined;
  readonly selected: string;
  readonly disabled: boolean;
  readonly onSelect: (hostname: string, name: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<DesktopTailscalePeers | null>(null);
  useEffect(() => {
    let current = true;
    setResult(null);
    const unavailable: DesktopTailscalePeers = { status: "unavailable", peers: [] };
    void Promise.resolve()
      .then(() => discover?.())
      .then(
        (value) => {
          if (current) setResult(value ?? unavailable);
        },
        () => {
          if (current) setResult(unavailable);
        },
      );
    return () => {
      current = false;
    };
  }, [discover, revision]);
  const reachable = result?.status === "available";
  const online = result?.peers.filter((peer) => peer.online) ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-slot="tailscale-peers">
      {result === null ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3" /> tailnet…
        </span>
      ) : !reachable ? (
        <span className="text-xs text-muted-foreground" role="status">
          Tailscale nicht erreichbar
        </span>
      ) : online.length === 0 ? (
        <span className="text-xs text-muted-foreground" role="status">
          Keine Geräte online
        </span>
      ) : (
        online.map((peer) => (
          <Button
            key={peer.id}
            type="button"
            size="xs"
            variant={selected === peer.hostname ? "default" : "outline"}
            aria-pressed={selected === peer.hostname}
            disabled={disabled}
            onClick={() => onSelect(peer.hostname, peer.name)}
          >
            {peer.name}
          </Button>
        ))
      )}
      {result !== null ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="tailnet neu laden"
          title="Neu laden"
          disabled={disabled}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCwIcon />
        </Button>
      ) : null}
    </div>
  );
}

export interface AddComputerInlineProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly segment: AddComputerKind;
  readonly onSegmentChange: (segment: AddComputerKind) => void;
  /** Ohne Auslöser-Button (z. B. eingebettet beim Instanz-Einrichten). */
  readonly alwaysOpen?: boolean;
  readonly localAvailable: boolean;
  readonly desktopAvailable: boolean;
  readonly sshAliases: ReadonlyArray<DesktopDiscoveredSshHost>;
  readonly knownHosts: ReadonlyArray<string>;
  readonly sshAliasesLoading: boolean;
  readonly onRefreshSshAliases?: () => void;
  readonly connectionError?: string | null;
  readonly catalogRecoveryAvailable?: boolean;
  readonly onRecoverCatalog?: () => void;
  /** Haken nur, wenn eine Instanz gewählt und bereit ist; sonst Statuszeile. */
  readonly rolesAvailable: boolean;
  readonly rolesStatus?: string | null;
  readonly discoverTailscalePeers?: () => Promise<DesktopTailscalePeers>;
  readonly inspectHostKey?: (
    target: WorkjetProvisioningTarget,
  ) => Promise<WorkjetSshHostKeyInspectResult>;
  /** Öffentliche Schlüssel aus ~/.ssh (nur Pfad und Fingerprint). */
  readonly sshKeys?: ReadonlyArray<ComputerSshKeyInfo>;
  readonly sshKeysLoading?: boolean;
  /** Schon erkannte Fakten für Local bzw. eine Adresse. */
  readonly knownComputer?: (
    kind: AddComputerKind,
    hostname: string | null,
  ) => KnownComputerFacts | null;
  readonly onAdd: (
    request: AddComputerRequest,
    progress?: (step: string) => void,
  ) => Promise<AddComputerOutcome>;
  readonly onDone?: () => void;
}

export function AddComputerInline({
  open,
  onOpenChange,
  segment,
  onSegmentChange,
  alwaysOpen = false,
  localAvailable,
  desktopAvailable,
  sshAliases,
  knownHosts,
  sshAliasesLoading,
  onRefreshSshAliases,
  connectionError,
  catalogRecoveryAvailable = false,
  onRecoverCatalog,
  rolesAvailable,
  rolesStatus,
  discoverTailscalePeers,
  inspectHostKey,
  sshKeys = [],
  sshKeysLoading = false,
  knownComputer,
  onAdd,
  onDone,
}: AddComputerInlineProps) {
  const listId = useId();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("");
  const [alias, setAlias] = useState<DesktopDiscoveredSshHost | null>(null);
  const [roles, setRoles] = useState<ComputerRoles>(DEFAULT_COMPUTER_ROLES);
  // null = unberührt: eine erkannte GPU ist dann vorab angehakt.
  const [gpuChoice, setGpuChoice] = useState<boolean | null>(null);
  const [keyChoice, setKeyChoice] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [step, setStep] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // „Erneut versuchen“ wiederholt genau den letzten Lauf, samt bestätigtem Host-Schlüssel.
  const [lastRequest, setLastRequest] = useState<AddComputerRequest | null>(null);
  const remote = segment !== "local";
  const endpointAvailable = remote && rolesAvailable;
  const known = knownComputer?.(segment, remote ? alias?.hostname || address.trim() || null : null);
  const gpuKnown = gpuDetected(known?.facts);
  const gpuAvailable = rolesAvailable && gpuKnown;
  const effectiveRoles: ComputerRoles = {
    build: endpointAvailable && roles.build,
    storage: endpointAvailable && roles.storage,
    gpu: gpuAvailable && (gpuChoice ?? true),
  };
  const knownKey = sshKeys.find((key) => known?.identityFiles.includes(key.path));
  const selectedKey = remote
    ? (keyChoice ??
      knownKey?.path ??
      sshKeys.find((key) => /id_ed25519$/.test(key.path))?.path ??
      sshKeys[0]?.path ??
      null)
    : null;
  const busy = phase.kind === "running";

  const reset = () => {
    setName("");
    setAddress("");
    setUsername("");
    setPort("");
    setAlias(null);
    setRoles(DEFAULT_COMPUTER_ROLES);
    setGpuChoice(null);
    setKeyChoice(null);
    setPhase({ kind: "form" });
    setStep(null);
    setFehler(null);
    setCopied(false);
    setLastRequest(null);
  };
  const close = () => {
    if (busy) return;
    reset();
    onOpenChange(false);
  };
  const finish = () => {
    reset();
    if (!alwaysOpen) onOpenChange(false);
    onDone?.();
  };

  const resolveTarget = (): DesktopSshEnvironmentTarget | null => {
    if (!remote) return null;
    if (alias) {
      const parsedPort = Number.parseInt(port, 10);
      return {
        alias: alias.alias,
        hostname: alias.hostname,
        username: username.trim() || alias.username,
        port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : alias.port,
      };
    }
    return parseManualDesktopSshTarget({ host: address, username, port });
  };

  const run = async (request: AddComputerRequest) => {
    setLastRequest(request);
    setPhase({ kind: "running" });
    setFehler(null);
    setStep(remote ? "Verbindet…" : "Prüft Werkzeuge…");
    try {
      const outcome = await onAdd(request, setStep);
      if (outcome.status === "error") {
        setPhase({ kind: "form" });
        setFehler(outcome.message);
        return;
      }
      if (outcome.status === "key") {
        setPhase({
          kind: "key",
          publicKey: outcome.publicKey,
          publicKeySha256: outcome.publicKeySha256,
          where: outcome.where,
        });
        return;
      }
      finish();
    } catch (failure) {
      setPhase({ kind: "form" });
      setFehler(
        failure instanceof Error && failure.message
          ? failure.message
          : "Hinzufügen fehlgeschlagen.",
      );
    } finally {
      setStep(null);
    }
  };

  const submit = async () => {
    if (phase.kind === "hostkey") {
      void run({
        ...phase.request,
        hostKey: { algorithm: phase.algorithm, fingerprint: phase.fingerprint },
      });
      return;
    }
    if (phase.kind === "key") {
      finish();
      return;
    }
    setFehler(null);
    let target: DesktopSshEnvironmentTarget | null;
    try {
      target = resolveTarget();
    } catch (failure) {
      setFehler(failure instanceof Error ? failure.message : "Adresse prüfen.");
      return;
    }
    const request: AddComputerRequest = {
      kind: segment,
      target,
      label: name.trim(),
      roles: effectiveRoles,
      hostKey: null,
      identityFile: selectedKey,
      gpuDecided: gpuAvailable,
    };
    const needsEndpoint = effectiveRoles.build || effectiveRoles.storage;
    if (target && needsEndpoint) {
      if (!target.username) {
        setFehler("Benutzer fehlt.");
        return;
      }
      if (inspectHostKey) {
        setPhase({ kind: "running" });
        setStep("Liest Host-Schlüssel…");
        try {
          const result = await inspectHostKey(provisioningTarget(target));
          if (result._tag === "failed") {
            setPhase({ kind: "form" });
            setFehler(result.message);
            return;
          }
          if (result._tag === "ready") {
            setPhase({
              kind: "hostkey",
              request,
              algorithm: result.algorithm,
              fingerprint: result.fingerprint,
            });
            return;
          }
        } catch (failure) {
          setPhase({ kind: "form" });
          setFehler(
            failure instanceof Error && failure.message
              ? failure.message
              : "Host nicht erreichbar.",
          );
          return;
        } finally {
          setStep(null);
        }
      }
    }
    void run(request);
  };

  const formDisabled = phase.kind !== "form";
  const segmentControl = (
    <div
      className="inline-flex rounded-md border p-0.5"
      role="radiogroup"
      aria-label="Verbindung"
      data-slot="add-computer-segment"
    >
      {SEGMENTS.map((entry) => (
        <button
          key={entry.value}
          type="button"
          role="radio"
          aria-checked={segment === entry.value}
          disabled={formDisabled}
          className={cn(
            "h-7 rounded px-3 text-[13.5px] transition-colors disabled:opacity-60",
            segment === entry.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => {
            setAlias(null);
            setAddress("");
            setFehler(null);
            onSegmentChange(entry.value);
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      readonly placeholder?: string;
      readonly className?: string;
      readonly list?: string;
      readonly inputMode?: "numeric";
    } = {},
  ) => (
    <label className={cn("grid gap-1 text-xs text-muted-foreground", options.className)}>
      {label}
      <Input
        nativeInput
        size="sm"
        value={value}
        disabled={formDisabled}
        spellCheck={false}
        autoComplete="off"
        {...(options.placeholder ? { placeholder: options.placeholder } : {})}
        {...(options.list ? { list: options.list } : {})}
        {...(options.inputMode ? { inputMode: options.inputMode } : {})}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );

  // Bei „Permission denied (publickey)“: der Befehl, der den gewählten Schlüssel einträgt.
  let copyIdCommand: string | null = null;
  if (fehler && selectedKey && remote && /publickey|permission denied/i.test(fehler)) {
    try {
      const target = lastRequest?.target ?? resolveTarget();
      if (target)
        copyIdCommand = sshCopyIdCommand(lastRequest?.identityFile ?? selectedKey, target);
    } catch {
      copyIdCommand = null;
    }
  }

  const statusLine =
    phase.kind === "running" ? (
      <span className="flex items-center gap-1.5">
        <Spinner className="size-3" />
        {step ?? "Läuft…"}
      </span>
    ) : fehler ? (
      <span className="flex flex-wrap items-center gap-2" data-slot="add-computer-error">
        <span className="min-w-0">{fehler}</span>
        {copyIdCommand ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            title={copyIdCommand}
            data-slot="add-computer-copy-id"
            onClick={() => {
              void navigator.clipboard?.writeText(copyIdCommand).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            <CopyIcon />
            {copied ? "Kopiert" : "Befehl kopieren"}
          </Button>
        ) : null}
        {catalogRecoveryAvailable && onRecoverCatalog ? (
          <Button type="button" size="xs" variant="outline" onClick={onRecoverCatalog}>
            Verbindungen zurücksetzen
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void (lastRequest ? run(lastRequest) : submit())}
        >
          Erneut versuchen
        </Button>
      </span>
    ) : connectionError ? (
      <span data-slot="add-computer-error">{connectionError}</span>
    ) : !rolesAvailable && remote && rolesStatus ? (
      rolesStatus
    ) : null;

  return (
    <InlinePanel
      triggerLabel="Rechner hinzufügen"
      open={open || alwaysOpen}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      segment={segmentControl}
      submitLabel={
        phase.kind === "hostkey" ? "Bestätigen" : phase.kind === "key" ? "Fertig" : "Hinzufügen"
      }
      onSubmit={() => void submit()}
      submitDisabled={
        phase.kind === "form" &&
        ((segment === "local" && !localAvailable) ||
          (remote && !desktopAvailable) ||
          (remote && !alias && address.trim() === ""))
      }
      busy={busy}
      status={statusLine}
      statusTone={fehler || connectionError ? "error" : "neutral"}
    >
      {segment === "local" ? (
        <div className="text-[13.5px] text-muted-foreground" data-slot="add-computer-local">
          {localAvailable ? "Dieser Rechner" : "Dieser Rechner ist nicht verbunden"}
        </div>
      ) : !desktopAvailable ? (
        <div className="text-[13.5px] text-muted-foreground" role="status">
          Nur mit der Desktop-App
        </div>
      ) : (
        <>
          {segment === "ssh" ? (
            <div className="flex flex-wrap items-center gap-1.5" data-slot="ssh-aliases">
              {sshAliases.map((entry) => {
                const selected = alias?.alias === entry.alias;
                return (
                  <Button
                    key={`${entry.alias}:${entry.hostname}:${entry.port ?? ""}`}
                    type="button"
                    size="xs"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    title={formatDesktopSshTarget(entry)}
                    disabled={formDisabled}
                    onClick={() => {
                      setFehler(null);
                      if (selected) {
                        setAlias(null);
                        return;
                      }
                      setAlias(entry);
                      setAddress(entry.hostname);
                      setUsername(entry.username ?? "");
                      setPort(entry.port ? String(entry.port) : "");
                    }}
                  >
                    {entry.alias}
                  </Button>
                );
              })}
              {sshAliasesLoading ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="size-3" /> ~/.ssh/config…
                </span>
              ) : sshAliases.length === 0 ? (
                <span className="text-xs text-muted-foreground">Keine SSH-Aliasse</span>
              ) : null}
              {onRefreshSshAliases ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="SSH-Aliasse neu laden"
                  title="Neu laden"
                  disabled={formDisabled || sshAliasesLoading}
                  onClick={onRefreshSshAliases}
                >
                  <RefreshCwIcon />
                </Button>
              ) : null}
            </div>
          ) : (
            <TailscalePeerChoices
              discover={discoverTailscalePeers}
              selected={address}
              disabled={formDisabled}
              onSelect={(hostname, peerName) => {
                setFehler(null);
                setAlias(null);
                setAddress(hostname);
                if (!name.trim()) setName(peerName);
              }}
            />
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_5rem_minmax(0,0.8fr)]">
            {field(
              "Adresse",
              address,
              (value) => {
                setAlias(null);
                setAddress(value);
              },
              {
                placeholder: segment === "tailscale" ? "100.x.x.x" : "192.168.1.10",
                list: `${listId}-hosts`,
                className: "col-span-2 sm:col-span-1",
              },
            )}
            {field("Benutzer", username, setUsername, {
              placeholder: alias?.username ?? "root",
            })}
            {field("Port", port, setPort, {
              placeholder: String(alias?.port ?? 22),
              inputMode: "numeric",
            })}
            {field("Name", name, setName, {
              placeholder: alias?.alias ?? "optional",
              className: "col-span-2 sm:col-span-1",
            })}
          </div>
          <datalist id={`${listId}-hosts`}>
            {knownHosts.map((host) => (
              <option key={host} value={host} />
            ))}
          </datalist>
          <div className="flex flex-wrap items-center gap-1.5" data-slot="ssh-keys">
            <span className="text-xs text-muted-foreground">Schlüssel</span>
            {sshKeys.map((key) => {
              const selected = selectedKey === key.path;
              return (
                <Button
                  key={key.path}
                  type="button"
                  size="xs"
                  variant={selected ? "default" : "outline"}
                  aria-pressed={selected}
                  title={key.publicKeyFingerprint ?? key.path}
                  disabled={formDisabled}
                  data-ssh-key={key.path}
                  onClick={() => setKeyChoice(key.path)}
                >
                  {keyName(key.path)}
                </Button>
              );
            })}
            {sshKeysLoading ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner className="size-3" /> ~/.ssh…
              </span>
            ) : sshKeys.length === 0 ? (
              <span className="text-xs text-muted-foreground">Keine Schlüssel</span>
            ) : null}
          </div>
        </>
      )}
      <ComputerRoleCheckboxes
        value={effectiveRoles}
        onChange={(next) => {
          setRoles({
            build: endpointAvailable ? next.build : roles.build,
            storage: endpointAvailable ? next.storage : roles.storage,
            gpu: false,
          });
          if (next.gpu !== effectiveRoles.gpu) setGpuChoice(next.gpu);
        }}
        disabled={formDisabled}
        endpointAvailable={endpointAvailable}
        gpuAvailable={gpuAvailable}
        gpuDetail={gpuSummary(known?.facts)}
      />
      {phase.kind === "hostkey" ? (
        <div className="flex min-w-0 items-center gap-2 text-[13.5px]" data-slot="host-key-confirm">
          <span className="shrink-0 text-muted-foreground">Host-Schlüssel</span>
          <code className="min-w-0 select-all truncate rounded bg-muted px-1.5 py-0.5 text-xs">
            {phase.algorithm} {phase.fingerprint}
          </code>
        </div>
      ) : null}
      {phase.kind === "key" ? (
        <div className="flex min-w-0 items-center gap-2 text-[13.5px]" data-slot="public-key">
          <span className="shrink-0 text-muted-foreground">Schlüssel für {phase.where}</span>
          <code
            className="min-w-0 select-all truncate rounded bg-muted px-1.5 py-0.5 text-xs"
            title={phase.publicKeySha256}
          >
            {phase.publicKey}
          </code>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(phase.publicKey).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            <CopyIcon />
            {copied ? "Kopiert" : "Kopieren"}
          </Button>
        </div>
      ) : null}
    </InlinePanel>
  );
}
