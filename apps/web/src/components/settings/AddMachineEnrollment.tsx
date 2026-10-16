"use client";

/**
 * Rechner hinzufügen mit einem Klick (Owner 15.10.; ctox sync v4 §16.41).
 *
 * Oben drei Arten als Segment: Lokal, SSH, Tailscale. Darunter, was zu der
 * Art gehört: dieser Rechner; die Hosts aus ~/.ssh/config; die tailnet-Geräte.
 * Unter SSH und Tailscale steht immer „Manuell“ (Adresse, Benutzer, Passwort).
 * Klick auf einen Eintrag + „Hinzufügen“ startet sofort; der Rechner steht
 * dann als Zeile mit Balken über die acht Vertragsschritte bis grün.
 * Das Passwort dient nur der ersten Anmeldung und wird nie gespeichert.
 */
import {
  KeyboardIcon,
  KeyRoundIcon,
  MonitorIcon,
  NetworkIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Row, type RowStatus } from "../ui/row";
import { Spinner } from "../ui/spinner";
import { Segment } from "../ui/segment";
import { CapabilitySwitch } from "./CapabilitySwitch";
import {
  machineCandidateAddress,
  machineEnrollmentError,
  machineEnrollmentLabels,
  machineEnrollmentDisplayProgress,
  machineEnrollmentProgress,
  machineEnrollmentStepLabel,
  parseManualAddress,
  startMachineEnrollment,
  type MachineCandidate,
  type MachineCapabilities,
  type MachineEnrollmentProgress,
  type MachineEnrollmentSnapshot,
  type MachineEnrollmentSource,
  type MachineEnrollmentTransport,
  type MachineInstallTransport,
  type MachineSources,
} from "./machineEnrollment";

const labels = machineEnrollmentLabels("de");
const ROW_DOT: Record<MachineEnrollmentProgress["phase"], RowStatus> = {
  running: "busy",
  failed: "error",
  green: "ok",
};
const CANDIDATE_TIMEOUT_MS = 10_000;
const CANDIDATE_RETRY_MS = 15_000;
const GREEN_HANDOVER_MS = 2_500;
const MANUAL = "manual";
const NEVER_KNOWN = () => false;

const SEGMENTS: ReadonlyArray<{
  readonly value: MachineEnrollmentTransport;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { value: "local", label: labels.transports.local, icon: <MonitorIcon /> },
  // D23: Terminal steht für Harness; SSH bekommt den Schlüssel.
  { value: "ssh", label: labels.transports.ssh, icon: <KeyRoundIcon /> },
  { value: "tailscale", label: labels.transports.tailscale, icon: <NetworkIcon /> },
];

interface EnrollmentEntry {
  readonly enrollmentId: string;
  readonly candidate: MachineCandidate;
  readonly name: string;
}

export interface AddMachineEnrollmentProps {
  readonly source: MachineEnrollmentSource;
  readonly transport: MachineInstallTransport;
  /** Startet offen (Fixture, Ersteinrichtung). */
  readonly defaultOpen?: boolean;
  /** Vorgewähltes Segment (Fixture); sonst das erste mit Einträgen, sonst SSH. */
  readonly defaultSegment?: MachineEnrollmentTransport;
  /** Grün: der Rechner steht nun in der Rechnerliste; die Fortschrittszeile geht. */
  readonly onGreen?: () => void;
  /** Schon vorhandene Rechner: Zeile mit grünem Punkt, nicht anklickbar. */
  readonly isKnown?: (candidate: MachineCandidate) => boolean;
  /** Steht der Rechner dieses Beitritts verbunden in der Rechnerliste? Dann geht die Zeile. */
  readonly isListedOnline?: (candidate: MachineCandidate) => boolean;
  /** „Tailscale nicht angemeldet · Öffnen“. */
  readonly onOpenTailscale?: () => void;
  readonly onRename?: (enrollmentId: string, name: string) => void;
  readonly onCapabilitiesChange?: (enrollmentId: string, capabilities: MachineCapabilities) => void;
}

/** Felder einer Zeile ohne bekannten Benutzer bzw. der Zeile „Manuell“. */
interface Credentials {
  readonly address: string;
  readonly user: string;
  readonly password: string;
}
const NO_CREDENTIALS: Credentials = { address: "", user: "", password: "" };

export function preselectSegment(
  sources: MachineSources | null,
  isKnown: (candidate: MachineCandidate) => boolean,
): MachineEnrollmentTransport {
  const has = (kind: MachineEnrollmentTransport) =>
    sources?.candidates.some((entry) => entry.transport === kind && !isKnown(entry)) ?? false;
  if (has("ssh")) return "ssh";
  if (has("tailscale")) return "tailscale";
  if (has("local")) return "local";
  return "ssh";
}

/** Bereits eingerichtete Rechner erscheinen nicht (N6), statt mit Chip „Vorhanden“. */
export function visibleMachineCandidates(
  candidates: ReadonlyArray<MachineCandidate>,
  segment: MachineEnrollmentTransport,
  enrolledIds: ReadonlySet<string>,
  isKnown: (candidate: MachineCandidate) => boolean,
): MachineCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.transport === segment && !enrolledIds.has(candidate.id) && !isKnown(candidate),
  );
}

export function AddMachineEnrollment({
  source,
  transport,
  defaultOpen = false,
  defaultSegment,
  isKnown = NEVER_KNOWN,
  isListedOnline = NEVER_KNOWN,
  onGreen,
  onOpenTailscale,
  onRename,
  onCapabilitiesChange,
}: AddMachineEnrollmentProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState<ReadonlyArray<EnrollmentEntry>>([]);
  const [segmentChoice, setSegmentChoice] = useState<MachineEnrollmentTransport | null>(
    defaultSegment ?? null,
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Credentials>(NO_CREDENTIALS);
  const [starting, setStarting] = useState(false);
  const sources = useCandidates(transport, open);
  const segment = segmentChoice ?? preselectSegment(sources.value, isKnown);

  const enrolledIds = new Set(entries.map((entry) => entry.candidate.id));
  const visible = visibleMachineCandidates(
    sources.value?.candidates ?? [],
    segment,
    enrolledIds,
    isKnown,
  );
  const picked =
    pickedId === MANUAL ? null : (visible.find((candidate) => candidate.id === pickedId) ?? null);
  const manual = pickedId === MANUAL && segment !== "local";
  const manualAddress = manual ? parseManualAddress(credentials.address) : null;
  const needsUser = picked !== null && picked.transport !== "local" && picked.user === null;
  const canStart =
    !starting &&
    (manual
      ? manualAddress !== null && credentials.user.trim() !== ""
      : picked !== null && (!needsUser || credentials.user.trim() !== ""));

  const start = useCallback(
    async (candidate: MachineCandidate, name: string, password?: string) => {
      const enrollmentId = await startMachineEnrollment(
        source,
        transport,
        candidate,
        name,
        password,
      );
      return { enrollmentId, candidate, name } satisfies EnrollmentEntry;
    },
    [source, transport],
  );

  const resetPick = () => {
    setPickedId(null);
    setCredentials(NO_CREDENTIALS);
  };

  const add = async () => {
    if (!canStart) return;
    let candidate: MachineCandidate;
    if (manual && manualAddress) {
      candidate = {
        id: `manual:${segment}:${manualAddress.host}`,
        transport: segment,
        name: manualAddress.host,
        user: credentials.user.trim(),
        host: manualAddress.host,
        port: manualAddress.port,
        sshAlias: null,
      };
    } else if (picked) {
      candidate = needsUser ? { ...picked, user: credentials.user.trim() } : picked;
    } else return;
    // Das Passwort geht nur an diesen einen Start und wird hier sofort verworfen.
    const password = credentials.password || undefined;
    resetPick();
    setStarting(true);
    try {
      const entry = await start(candidate, candidate.name, password);
      setEntries((current) => [...current, entry]);
      setOpen(false);
    } finally {
      setStarting(false);
    }
  };

  // „Erneut“ = neues begin (Token einmalig); die Zeile bleibt an ihrem Platz.
  const retry = async (entry: EnrollmentEntry, candidate: MachineCandidate, password?: string) => {
    void source.cancel(entry.enrollmentId);
    const next = await start(candidate, entry.name, password);
    setEntries((current) =>
      current.map((existing) => (existing.enrollmentId === entry.enrollmentId ? next : existing)),
    );
  };

  const abort = (entry: EnrollmentEntry) => {
    void source.cancel(entry.enrollmentId);
    setEntries((current) =>
      current.filter((existing) => existing.enrollmentId !== entry.enrollmentId),
    );
  };

  const credentialFields = (withAddress: boolean) => (
    <div
      className="grid grid-cols-1 gap-2 px-2 pb-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]"
      data-slot={withAddress ? "machine-source-manual-fields" : "machine-source-user"}
    >
      {withAddress ? (
        <CredentialField
          label={labels.address}
          value={credentials.address}
          placeholder={segment === "tailscale" ? "gpu4 / 100.x.x.x" : "192.168.1.10:22"}
          autoFocus
          onChange={(address) => setCredentials((current) => ({ ...current, address }))}
        />
      ) : null}
      <CredentialField
        label={labels.user}
        value={credentials.user}
        autoFocus={!withAddress}
        onChange={(user) => setCredentials((current) => ({ ...current, user }))}
      />
      <CredentialField
        label={labels.password}
        value={credentials.password}
        secret
        onChange={(password) => setCredentials((current) => ({ ...current, password }))}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-slot="machine-enrollment">
      {entries.length > 0 ? (
        // D21: laufende Beitritte stehen als Zeilen wie die Rechnerliste, nicht als Karte.
        <div
          className="divide-y divide-border/60 border-y border-border/60"
          data-slot="machine-enrollment-rows"
        >
          {entries.map((entry) => (
            <EnrollmentRow
              key={entry.enrollmentId}
              entry={entry}
              source={source}
              listedOnline={isListedOnline(entry.candidate)}
              onRetry={(candidate, password) => void retry(entry, candidate, password)}
              onGreen={() => {
                // Kurz grün stehen lassen, dann übernimmt die Zeile der Rechnerliste.
                globalThis.setTimeout(() => {
                  setEntries((current) =>
                    current.filter((existing) => existing.enrollmentId !== entry.enrollmentId),
                  );
                }, GREEN_HANDOVER_MS);
                onGreen?.();
              }}
              onAbort={() => abort(entry)}
              onRename={(name) => {
                setEntries((current) =>
                  current.map((existing) =>
                    existing.enrollmentId === entry.enrollmentId ? { ...existing, name } : existing,
                  ),
                );
                onRename?.(entry.enrollmentId, name);
              }}
              {...(onCapabilitiesChange
                ? {
                    onCapabilitiesChange: (capabilities: MachineCapabilities) =>
                      onCapabilitiesChange(entry.enrollmentId, capabilities),
                  }
                : {})}
            />
          ))}
        </div>
      ) : null}
      {open ? (
        <form
          aria-label={labels.add}
          className="flex flex-col gap-2 rounded-lg border bg-card/40 p-2"
          data-slot="machine-sources"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <Segment
              aria-label={labels.add}
              value={segment}
              disabled={starting}
              onValueChange={(value) => {
                setSegmentChoice(value);
                resetPick();
              }}
              options={SEGMENTS.map((entry) => ({
                value: entry.value,
                label: entry.label,
                icon: entry.icon,
                attributes: { "data-segment": entry.value },
              }))}
            />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={labels.reload}
              title={labels.reload}
              disabled={sources.loading}
              onClick={sources.reload}
            >
              <RefreshCwIcon />
            </Button>
          </div>
          <div className="flex flex-col" role="listbox" aria-label={labels.add}>
            {visible.map((candidate) => {
              const known = isKnown(candidate);
              const selected = candidate.id === pickedId;
              return (
                <div key={candidate.id} className="flex flex-col">
                  <CandidateRow
                    candidate={candidate}
                    selected={selected}
                    known={known}
                    disabled={starting || known}
                    onSelect={() => {
                      setCredentials(NO_CREDENTIALS);
                      setPickedId(selected ? null : candidate.id);
                    }}
                  />
                  {selected && needsUser ? credentialFields(false) : null}
                </div>
              );
            })}
            {sources.loading && visible.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-2 text-muted-foreground text-xs">
                <Spinner className="size-3" />
              </div>
            ) : null}
            {segment === "tailscale" && sources.value && !sources.value.tailscale ? (
              <div
                className="flex items-center gap-2 px-2 py-1.5 text-[13.5px]"
                data-slot="machine-source-tailscale-off"
              >
                <span className="text-muted-foreground">{labels.tailscaleSignedOut}</span>
                {onOpenTailscale ? (
                  <Button type="button" size="xs" variant="outline" onClick={onOpenTailscale}>
                    {labels.tailscaleSignIn}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {segment !== "local" ? (
              <div className="flex flex-col">
                <button
                  type="button"
                  role="option"
                  aria-selected={manual}
                  disabled={starting}
                  data-slot="machine-source"
                  data-candidate={MANUAL}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13.5px] transition-colors disabled:opacity-64",
                    manual ? "bg-primary/15 ring-1 ring-primary/60" : "hover:bg-accent/40",
                  )}
                  onClick={() => {
                    setCredentials(NO_CREDENTIALS);
                    setPickedId(manual ? null : MANUAL);
                  }}
                >
                  <KeyboardIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{labels.manual}</span>
                </button>
                {manual ? credentialFields(true) : null}
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 px-1 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(false);
                resetPick();
              }}
            >
              {labels.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={!canStart} data-slot="machine-source-add">
              {starting ? <Spinner className="size-3.5" /> : null}
              {labels.addSubmit}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          className="self-start"
          size="sm"
          variant="outline"
          data-slot="machine-sources-trigger"
          onClick={() => setOpen(true)}
        >
          <MonitorIcon />
          {labels.add}
        </Button>
      )}
    </div>
  );
}

function CredentialField({
  label,
  value,
  onChange,
  placeholder,
  secret = false,
  autoFocus = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly autoFocus?: boolean;
}) {
  return (
    <label className="grid gap-1 text-muted-foreground text-xs">
      {label}
      <Input
        nativeInput
        size="sm"
        type={secret ? "password" : "text"}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete={secret ? "new-password" : "off"}
        value={value}
        {...(placeholder ? { placeholder } : {})}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** Lädt die Quellen beim Öffnen; was ausfällt, wird still wiederholt. */
function useCandidates(transport: MachineInstallTransport, open: boolean) {
  const [value, setValue] = useState<MachineSources | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    const timeout = globalThis.setTimeout(() => {
      if (current) setLoading(false);
    }, CANDIDATE_TIMEOUT_MS);
    let retry: ReturnType<typeof setTimeout> | undefined;
    void transport.listCandidates().then(
      (next) => {
        if (!current) return;
        setValue(next);
        setLoading(false);
      },
      () => {
        if (!current) return;
        setLoading(false);
        retry = globalThis.setTimeout(() => setRevision((count) => count + 1), CANDIDATE_RETRY_MS);
      },
    );
    return () => {
      current = false;
      globalThis.clearTimeout(timeout);
      if (retry) globalThis.clearTimeout(retry);
    };
  }, [transport, open, revision]);
  return { value, loading, reload: () => setRevision((count) => count + 1) };
}

function CandidateRow({
  candidate,
  selected,
  known,
  disabled,
  onSelect,
}: {
  readonly candidate: MachineCandidate;
  readonly selected: boolean;
  readonly known: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const address = machineCandidateAddress(candidate);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={known}
      disabled={disabled}
      data-slot="machine-source"
      data-candidate={candidate.id}
      data-known={known ? "true" : "false"}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13.5px] transition-colors",
        known ? "cursor-default" : "disabled:opacity-64",
        selected ? "bg-primary/15 ring-1 ring-primary/60" : !known && "hover:bg-accent/40",
      )}
      onClick={onSelect}
    >
      <MonitorIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className={cn("flex min-w-0 flex-1 flex-col", known && "opacity-64")}>
        <span className="truncate font-medium">{candidate.name}</span>
        {candidate.transport === "local" || address ? (
          <span className="truncate text-muted-foreground text-xs">
            {candidate.transport === "local" ? labels.thisComputer : address}
          </span>
        ) : null}
      </span>
      {/* D06: Vorhandenes als Hinweis, kein Statuspunkt, der dem Listenstatus widerspricht. */}
      {known ? (
        <span
          className="inline-flex h-5 shrink-0 items-center rounded bg-muted px-1.5 text-[11px] text-muted-foreground"
          data-slot="machine-source-known"
        >
          {labels.known}
        </span>
      ) : null}
    </button>
  );
}

function useEnrollmentSnapshot(source: MachineEnrollmentSource, enrollmentId: string) {
  const [snapshot, setSnapshot] = useState<MachineEnrollmentSnapshot>({ steps: [] });
  useEffect(() => source.watch(enrollmentId, setSnapshot), [source, enrollmentId]);
  return snapshot;
}

function EnrollmentRow({
  entry,
  source,
  listedOnline,
  onRetry,
  onGreen,
  onAbort,
  onRename,
  onCapabilitiesChange,
}: {
  readonly entry: EnrollmentEntry;
  readonly source: MachineEnrollmentSource;
  readonly listedOnline: boolean;
  readonly onRetry: (candidate: MachineCandidate, password?: string) => void;
  readonly onGreen: () => void;
  readonly onAbort: () => void;
  readonly onRename: (name: string) => void;
  readonly onCapabilitiesChange?: (capabilities: MachineCapabilities) => void;
}) {
  const snapshot = useEnrollmentSnapshot(source, entry.enrollmentId);
  const progress = machineEnrollmentDisplayProgress(
    machineEnrollmentProgress(snapshot.steps),
    listedOnline,
  );
  const green = progress.phase === "green";
  const greenSeen = useRef(false);
  useEffect(() => {
    if (!green || greenSeen.current) return;
    greenSeen.current = true;
    onGreen();
  }, [green, onGreen]);
  const [details, setDetails] = useState(false);
  // Inline-Felder bei „Benutzer prüfen“ / „Passwort falsch“; das Passwort lebt nur hier.
  const [userEdit, setUserEdit] = useState<{ user: string; password: string } | null>(null);
  const failure = progress.fault ? machineEnrollmentError(progress.fault.error_code) : null;
  const dot = ROW_DOT[progress.phase];
  const stepLabel = machineEnrollmentStepLabel(progress.key);

  const meta = failure ? (
    <span
      className="whitespace-normal text-destructive"
      data-slot="machine-enrollment-error"
      title={progress.fault?.detail ?? undefined}
    >
      {failure.text}
    </span>
  ) : progress.phase === "green" ? (
    (machineCandidateAddress(entry.candidate) ?? labels.thisComputer)
  ) : (
    <span data-slot="machine-enrollment-step">{stepLabel}</span>
  );

  const [chosen, setChosen] = useState<CapabilityChoice>({ build: true, storage: true, gpu: true });
  const capabilitySwitches = (className: string) => (
    <CapabilitySwitches
      className={className}
      capabilities={snapshot.capabilities ?? null}
      chosen={chosen}
      onChosenChange={(next) => {
        setChosen(next);
        const detected = snapshot.capabilities;
        if (detected)
          onCapabilitiesChange?.({
            build: detected.build && next.build,
            storage: detected.storage && next.storage,
            gpu: next.gpu ? detected.gpu : null,
          });
      }}
    />
  );
  const chips =
    progress.phase === "green" ? (
      // Breit als Chips, schmal (420 px) als eigene Zeile darunter.
      capabilitySwitches("hidden sm:flex")
    ) : (
      <>
        {progress.phase === "running" ? (
          <ProgressBar fraction={progress.fraction} label={stepLabel} />
        ) : null}
        {failure && progress.fault ? (
          // D08: genau eine Aktion; der Rohtext steht nur hinter „Details“ (Host-Schlüssel).
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-slot="machine-enrollment-action"
            onClick={() => {
              if (failure.action === "user" || failure.action === "password")
                setUserEdit({ user: entry.candidate.user ?? "", password: "" });
              else if (failure.action === "details") setDetails((value) => !value);
              else onRetry(entry.candidate);
            }}
          >
            {failure.actionLabel}
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={labels.abort}
          title={labels.abort}
          onClick={onAbort}
        >
          <XIcon />
        </Button>
      </>
    );

  return (
    <div data-slot="machine-enrollment-row" data-state={progress.phase} data-step={progress.key}>
      <Row
        status={dot}
        statusLabel={progress.phase === "failed" ? (failure?.text ?? stepLabel) : stepLabel}
        name={<InlineName value={entry.name} onCommit={onRename} />}
        meta={meta}
        chips={chips}
      />
      {progress.phase === "green" ? capabilitySwitches("flex px-3 pb-2 sm:hidden") : null}
      {userEdit !== null ? (
        <form
          className="flex flex-wrap items-end gap-2 px-3 pb-2 text-muted-foreground text-xs"
          data-slot="machine-enrollment-user"
          onSubmit={(event) => {
            event.preventDefault();
            const user = userEdit.user.trim();
            if (!user) return;
            const password = userEdit.password || undefined;
            setUserEdit(null);
            onRetry({ ...entry.candidate, user }, password);
          }}
        >
          <label className="grid gap-1">
            {labels.user}
            <Input
              nativeInput
              size="sm"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              className="w-44"
              value={userEdit.user}
              onChange={(event) => setUserEdit({ ...userEdit, user: event.target.value })}
            />
          </label>
          <label className="grid gap-1">
            {labels.password}
            <Input
              nativeInput
              size="sm"
              type="password"
              autoComplete="new-password"
              className="w-44"
              value={userEdit.password}
              onChange={(event) => setUserEdit({ ...userEdit, password: event.target.value })}
            />
          </label>
          <Button type="submit" size="xs" disabled={userEdit.user.trim() === ""}>
            {labels.connect}
          </Button>
        </form>
      ) : null}
      {details && progress.fault?.detail ? (
        <pre
          className="mx-3 mb-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-muted-foreground text-xs"
          data-slot="machine-enrollment-details"
        >
          {progress.fault.detail}
        </pre>
      ) : null}
    </div>
  );
}

function ProgressBar({ fraction, label }: { readonly fraction: number; readonly label: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-28 overflow-hidden rounded-full bg-muted sm:w-40"
      data-slot="machine-enrollment-progress"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(percent, 4)}%` }}
      />
    </div>
  );
}

interface CapabilityChoice {
  readonly build: boolean;
  readonly storage: boolean;
  readonly gpu: boolean;
}

/** Erst nach der Verbindung: erkannte Fähigkeiten als Schalter zum Abwählen. */
function CapabilitySwitches({
  capabilities,
  chosen,
  onChosenChange,
  className,
}: {
  readonly capabilities: MachineCapabilities | null;
  readonly chosen: CapabilityChoice;
  readonly onChosenChange: (chosen: CapabilityChoice) => void;
  readonly className: string;
}) {
  if (!capabilities) return null;
  const items = (
    [
      ["build", capabilities.build ? labels.capabilities.build : null],
      ["storage", capabilities.storage ? labels.capabilities.storage : null],
      ["gpu", capabilities.gpu ? `${labels.capabilities.gpu} ${capabilities.gpu}` : null],
    ] as const
  ).filter((item): item is readonly ["build" | "storage" | "gpu", string] => item[1] !== null);
  return (
    <div
      className={cn("flex-wrap items-center gap-x-3 gap-y-1.5", className)}
      data-slot="machine-capabilities"
    >
      {items.map(([key, text]) => (
        <CapabilitySwitch
          key={key}
          capability={key}
          label={text}
          checked={chosen[key]}
          onCheckedChange={(checked) => onChosenChange({ ...chosen, [key]: checked })}
        />
      ))}
    </div>
  );
}

/** Name = Hostname; Klick macht ihn zum Feld, Enter oder Verlassen übernimmt. */
function InlineName({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (draft !== null) inputRef.current?.select();
  }, [draft !== null]);
  if (draft === null) {
    return (
      <button
        type="button"
        className="max-w-full truncate rounded text-left font-medium focus-visible:outline-2 focus-visible:outline-ring"
        title={labels.rename}
        data-slot="machine-enrollment-name"
        onClick={() => setDraft(value)}
      >
        {value}
      </button>
    );
  }
  const commit = () => {
    const next = draft.trim();
    setDraft(null);
    if (next && next !== value) onCommit(next);
  };
  return (
    <input
      ref={inputRef}
      aria-label={labels.rename}
      className="w-full max-w-64 rounded border bg-background px-1.5 py-0.5 font-medium text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      value={draft}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}
