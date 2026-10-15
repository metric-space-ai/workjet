"use client";

/**
 * Rechner hinzufügen mit einem Klick (Owner 15.10.; ctox sync v4 §16.41).
 *
 * Eine Liste der Quellen (dieser Rechner, SSH-Hosts aus ~/.ssh/config,
 * tailnet-Geräte). Klick auf einen Eintrag + „Hinzufügen“ startet sofort; der
 * Rechner steht dann als Zeile mit Balken über die acht Vertragsschritte bis
 * grün. Kein Formular: Adresse, Benutzer, Port und Schlüssel löst der Desktop
 * auf. Fähigkeiten erscheinen erst nach der Verbindung, als Schalter.
 */
import { MonitorIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Row, type RowStatus } from "../ui/row";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  machineCandidateAddress,
  machineEnrollmentError,
  machineEnrollmentLabels,
  machineEnrollmentProgress,
  machineEnrollmentStepLabel,
  startMachineEnrollment,
  type MachineCandidate,
  type MachineCapabilities,
  type MachineEnrollmentSnapshot,
  type MachineEnrollmentSource,
  type MachineInstallTransport,
} from "./machineEnrollment";

const labels = machineEnrollmentLabels("de");
const CANDIDATE_TIMEOUT_MS = 10_000;
const CANDIDATE_RETRY_MS = 15_000;

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
  readonly onRename?: (enrollmentId: string, name: string) => void;
  readonly onCapabilitiesChange?: (enrollmentId: string, capabilities: MachineCapabilities) => void;
}

export function AddMachineEnrollment({
  source,
  transport,
  defaultOpen = false,
  onRename,
  onCapabilitiesChange,
}: AddMachineEnrollmentProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState<ReadonlyArray<EnrollmentEntry>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [userInput, setUserInput] = useState("");
  const [starting, setStarting] = useState(false);
  const candidates = useCandidates(transport, open);

  const enrolledIds = new Set(entries.map((entry) => entry.candidate.id));
  const visible = (candidates.list ?? []).filter((candidate) => !enrolledIds.has(candidate.id));
  const picked = visible.find((candidate) => candidate.id === selected) ?? null;
  const needsUser = picked !== null && picked.transport !== "local" && picked.user === null;
  const canStart = picked !== null && (!needsUser || userInput.trim() !== "") && !starting;

  const start = useCallback(
    async (candidate: MachineCandidate, name: string) => {
      const enrollmentId = await startMachineEnrollment(source, transport, candidate, name);
      return { enrollmentId, candidate, name } satisfies EnrollmentEntry;
    },
    [source, transport],
  );

  const add = async () => {
    if (!picked || !canStart) return;
    const candidate = needsUser ? { ...picked, user: userInput.trim() } : picked;
    setStarting(true);
    try {
      const entry = await start(candidate, candidate.name);
      setEntries((current) => [...current, entry]);
      setSelected(null);
      setUserInput("");
      setOpen(false);
    } finally {
      setStarting(false);
    }
  };

  // „Erneut“ = neues begin (Token einmalig); die Zeile bleibt an ihrem Platz.
  const retry = async (entry: EnrollmentEntry, candidate: MachineCandidate) => {
    void source.cancel(entry.enrollmentId);
    const next = await start(candidate, entry.name);
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

  return (
    <div className="flex flex-col gap-3" data-slot="machine-enrollment">
      {entries.length > 0 ? (
        <div className="divide-y rounded-lg border" data-slot="machine-enrollment-rows">
          {entries.map((entry) => (
            <EnrollmentRow
              key={entry.enrollmentId}
              entry={entry}
              source={source}
              onRetry={(candidate) => void retry(entry, candidate)}
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
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="font-medium text-[13.5px]">{labels.add}</span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={labels.reload}
              title={labels.reload}
              disabled={candidates.loading}
              onClick={candidates.reload}
            >
              <RefreshCwIcon />
            </Button>
          </div>
          <div className="flex flex-col" role="listbox" aria-label={labels.add}>
            {visible.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                selected={candidate.id === selected}
                disabled={starting}
                onSelect={() => {
                  setSelected(candidate.id === selected ? null : candidate.id);
                  setUserInput("");
                }}
              />
            ))}
            {candidates.loading && visible.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-2 text-muted-foreground text-xs">
                <Spinner className="size-3" />
              </div>
            ) : null}
            {!candidates.loading && visible.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-2 text-[13.5px]" role="status">
                <span className="text-muted-foreground">{labels.sourcesEmpty}</span>
                <Button type="button" size="xs" variant="outline" onClick={candidates.reload}>
                  {labels.retry}
                </Button>
              </div>
            ) : null}
          </div>
          {needsUser ? (
            <label
              className="flex items-center gap-2 px-2 text-muted-foreground text-xs"
              data-slot="machine-source-user"
            >
              {labels.user}
              <Input
                nativeInput
                size="sm"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="max-w-56"
                value={userInput}
                onChange={(event) => setUserInput(event.target.value)}
              />
            </label>
          ) : null}
          <div className="flex items-center justify-end gap-2 px-1 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(false);
                setSelected(null);
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

/** Lädt die Quellen beim Öffnen; was ausfällt, wird still wiederholt. */
function useCandidates(transport: MachineInstallTransport, open: boolean) {
  const [list, setList] = useState<ReadonlyArray<MachineCandidate> | null>(null);
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
      (value) => {
        if (!current) return;
        setList(value);
        setLoading(false);
      },
      () => {
        if (!current) return;
        setLoading(false);
        retry = globalThis.setTimeout(() => setRevision((value) => value + 1), CANDIDATE_RETRY_MS);
      },
    );
    return () => {
      current = false;
      globalThis.clearTimeout(timeout);
      if (retry) globalThis.clearTimeout(retry);
    };
  }, [transport, open, revision]);
  return { list, loading, reload: () => setRevision((value) => value + 1) };
}

function CandidateRow({
  candidate,
  selected,
  disabled,
  onSelect,
}: {
  readonly candidate: MachineCandidate;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const address = machineCandidateAddress(candidate);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      data-slot="machine-source"
      data-candidate={candidate.id}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13.5px] transition-colors disabled:opacity-64",
        selected ? "bg-primary/15 ring-1 ring-primary/60" : "hover:bg-accent/40",
      )}
      onClick={onSelect}
    >
      <MonitorIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{candidate.name}</span>
        <span className="truncate text-muted-foreground text-xs">
          {candidate.transport === "local" ? labels.thisComputer : address}
        </span>
      </span>
      <span className="shrink-0 rounded border px-1.5 py-px text-[11px] text-muted-foreground">
        {labels.transports[candidate.transport]}
      </span>
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
  onRetry,
  onAbort,
  onRename,
  onCapabilitiesChange,
}: {
  readonly entry: EnrollmentEntry;
  readonly source: MachineEnrollmentSource;
  readonly onRetry: (candidate: MachineCandidate) => void;
  readonly onAbort: () => void;
  readonly onRename: (name: string) => void;
  readonly onCapabilitiesChange?: (capabilities: MachineCapabilities) => void;
}) {
  const snapshot = useEnrollmentSnapshot(source, entry.enrollmentId);
  const progress = machineEnrollmentProgress(snapshot.steps);
  const [details, setDetails] = useState(false);
  const [userEdit, setUserEdit] = useState<string | null>(null);
  const failure = progress.failed ? machineEnrollmentError(progress.failed.error_code) : null;
  const status: RowStatus =
    progress.status === "green" ? "ok" : progress.status === "failed" ? "error" : "busy";
  const stepLabel = machineEnrollmentStepLabel(progress.key);

  const meta =
    progress.status === "failed" && failure ? (
      <span className="whitespace-normal text-destructive" data-slot="machine-enrollment-error">
        {failure.text}
      </span>
    ) : progress.status === "green" ? (
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
    progress.status === "green" ? (
      // Breit in der Zeile, schmal (420 px) als eigene Zeile darunter.
      capabilitySwitches("hidden sm:flex")
    ) : (
      <>
        {progress.status === "running" ? (
          <ProgressBar fraction={progress.fraction} label={stepLabel} />
        ) : null}
        {failure && progress.failed ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-slot="machine-enrollment-action"
              onClick={() => {
                if (failure.action === "user") setUserEdit(entry.candidate.user ?? "");
                else onRetry(entry.candidate);
              }}
            >
              {failure.actionLabel}
            </Button>
            {progress.failed.detail ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-expanded={details}
                onClick={() => setDetails((value) => !value)}
              >
                {labels.details}
              </Button>
            ) : null}
          </>
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
    <div data-slot="machine-enrollment-row" data-state={progress.status} data-step={progress.key}>
      <Row
        status={status}
        statusLabel={progress.status === "failed" ? (failure?.text ?? stepLabel) : stepLabel}
        name={<InlineName value={entry.name} onCommit={onRename} />}
        meta={meta}
        chips={chips}
      />
      {progress.status === "green" ? capabilitySwitches("flex px-3 pb-2 sm:hidden") : null}
      {userEdit !== null ? (
        <form
          className="flex flex-wrap items-center gap-2 px-3 pb-2 text-muted-foreground text-xs"
          data-slot="machine-enrollment-user"
          onSubmit={(event) => {
            event.preventDefault();
            const user = userEdit.trim();
            if (!user) return;
            setUserEdit(null);
            onRetry({ ...entry.candidate, user });
          }}
        >
          {labels.user}
          <Input
            nativeInput
            size="sm"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            className="max-w-56"
            value={userEdit}
            onChange={(event) => setUserEdit(event.target.value)}
          />
          <Button type="submit" size="xs" disabled={userEdit.trim() === ""}>
            {labels.retry}
          </Button>
        </form>
      ) : null}
      {details && progress.failed?.detail ? (
        <pre
          className="mx-3 mb-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-muted-foreground text-xs"
          data-slot="machine-enrollment-details"
        >
          {progress.failed.detail}
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
        <label key={key} className="flex items-center gap-1.5 text-xs">
          <Switch
            checked={chosen[key]}
            onCheckedChange={(checked) => onChosenChange({ ...chosen, [key]: checked })}
          />
          {text}
        </label>
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
