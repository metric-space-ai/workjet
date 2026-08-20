import {
  EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS,
  EnvironmentId,
  WorkjetGatewayAccountId,
  type WorkjetLegacyImportBindableTargets,
  type WorkjetLegacyImportBindings,
  type WorkjetLegacyImportInspection,
  type WorkjetLegacyImportPending,
} from "@t3tools/contracts";
import { CheckCircle2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The Workjet settings surface for the ONE-SHOT legacy Swift import.
 *
 * The server decides; this panel only shows the decision and carries the
 * operator's answer back. Three things it must never soften:
 *
 * 1. NOTHING IS GUESSED. Three legacy references have no destination — a
 *    computer's Code environment, a provider's gateway account, and a provider
 *    POOL's account — so each is a control here. A record left unanswered blocks
 *    the accept outright; a record the operator SKIPS says, at the control, that
 *    it will not be imported.
 * 2. A POOL BINDING LOSES FAILOVER. A legacy pool is an ordered set of accounts
 *    and the destination route is one account, so the warning sits AT the pool
 *    control, before the choice, not in a footnote after it.
 * 3. THE DECISION IS TERMINAL. Accept and decline are both recorded once and
 *    never offered again, so the button says so and the recorded state shows its
 *    date.
 */

export type WorkjetLegacyImportAnswer =
  | { readonly _tag: "skip" }
  | { readonly _tag: "bind"; readonly targetId: string };

/** Answers by record key. An absent key is UNANSWERED, which blocks accept. */
export type WorkjetLegacyImportDraft = Readonly<Record<string, WorkjetLegacyImportAnswer>>;

export type WorkjetLegacyImportOffer = Extract<
  WorkjetLegacyImportInspection,
  { readonly state: "offer" }
>;

/** Stable key for one pending record, used by the draft and the controls. */
export function legacyImportRecordKey(record: WorkjetLegacyImportPending): string {
  switch (record.kind) {
    case "computer-environment":
      return `computer:${record.computerId}`;
    case "provider-account":
      return `provider:${record.providerId}`;
    case "provider-pool-account":
      return `pool:${record.pool}`;
    case "worker":
      return `worker:${record.workerId}`;
  }
}

/** The records an operator can actually answer. A worker is a consequence. */
export function legacyImportBindableRecords(
  pending: ReadonlyArray<WorkjetLegacyImportPending>,
): ReadonlyArray<Exclude<WorkjetLegacyImportPending, { readonly kind: "worker" }>> {
  return pending.filter(
    (record): record is Exclude<WorkjetLegacyImportPending, { readonly kind: "worker" }> =>
      record.kind !== "worker",
  );
}

export interface WorkjetLegacyImportAcceptState {
  readonly bindableCount: number;
  readonly answeredCount: number;
  readonly boundCount: number;
  readonly skippedCount: number;
  readonly unansweredCount: number;
  /**
   * Accept is enabled only when every bindable record has been answered. An
   * offer with nothing to bind (or nothing to import beyond the settings
   * scalars) is still acceptable — there is simply nothing to resolve.
   */
  readonly canAccept: boolean;
}

export function legacyImportAcceptState(
  pending: ReadonlyArray<WorkjetLegacyImportPending>,
  draft: WorkjetLegacyImportDraft,
): WorkjetLegacyImportAcceptState {
  const bindable = legacyImportBindableRecords(pending);
  let bound = 0;
  let skipped = 0;
  for (const record of bindable) {
    const answer = draft[legacyImportRecordKey(record)];
    if (answer === undefined) continue;
    if (answer._tag === "skip") skipped += 1;
    else if (answer.targetId.length > 0) bound += 1;
  }
  const answered = bound + skipped;
  return {
    bindableCount: bindable.length,
    answeredCount: answered,
    boundCount: bound,
    skippedCount: skipped,
    unansweredCount: bindable.length - answered,
    canAccept: answered === bindable.length,
  };
}

/**
 * The wire payload for the draft. Every bindable record appears exactly once,
 * as a binding or as an explicit skip, which is what the server requires: it
 * refuses an accept that leaves one unanswered rather than quietly dropping it.
 */
export function legacyImportDecideBindings(
  pending: ReadonlyArray<WorkjetLegacyImportPending>,
  draft: WorkjetLegacyImportDraft,
): WorkjetLegacyImportBindings {
  const bindings: {
    computers: Array<{ computerId: string; environmentId: EnvironmentId }>;
    providers: Array<{ providerId: string; gatewayAccountId: WorkjetGatewayAccountId }>;
    pools: Array<{
      pool: string;
      gatewayAccountId: WorkjetGatewayAccountId;
      acknowledgeFailoverLoss: true;
    }>;
    skippedComputerIds: string[];
    skippedProviderIds: string[];
    skippedPools: string[];
  } = {
    computers: [],
    providers: [],
    pools: [],
    skippedComputerIds: [],
    skippedProviderIds: [],
    skippedPools: [],
  };

  for (const record of legacyImportBindableRecords(pending)) {
    const answer = draft[legacyImportRecordKey(record)];
    if (answer === undefined) continue;
    const skipped = answer._tag === "skip" || answer.targetId.length === 0;
    switch (record.kind) {
      case "computer-environment":
        if (skipped) bindings.skippedComputerIds.push(record.computerId);
        else if (answer._tag === "bind") {
          bindings.computers.push({
            computerId: record.computerId,
            environmentId: EnvironmentId.make(answer.targetId),
          });
        }
        break;
      case "provider-account":
        if (skipped) bindings.skippedProviderIds.push(record.providerId);
        else if (answer._tag === "bind") {
          bindings.providers.push({
            providerId: record.providerId,
            gatewayAccountId: WorkjetGatewayAccountId.make(answer.targetId),
          });
        }
        break;
      case "provider-pool-account":
        if (skipped) bindings.skippedPools.push(record.pool);
        else if (answer._tag === "bind") {
          bindings.pools.push({
            pool: record.pool,
            gatewayAccountId: WorkjetGatewayAccountId.make(answer.targetId),
            // Choosing an account in this control IS the acknowledgement: the
            // control states the loss directly above the selection, so the
            // operator cannot make this choice without having been told.
            acknowledgeFailoverLoss: true,
          });
        }
        break;
    }
  }

  return { ...EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS, ...bindings };
}

export const WORKJET_LEGACY_IMPORT_SKIP_VALUE = "__skip__";

/** What a skipped record means, stated wherever a record can be skipped. */
export const WORKJET_LEGACY_IMPORT_SKIP_NOTICE =
  "Skipped: this record will not be imported, and neither will anything that depends on it.";

/** The consequence of narrowing a pool onto one account, stated at the control. */
export const WORKJET_LEGACY_IMPORT_FAILOVER_NOTICE =
  "A pool is an ordered set of accounts; an LLM route is one account. Binding this pool keeps only the account you choose — the pool's failover across its other accounts is NOT imported.";

export interface WorkjetLegacyImportSectionState {
  readonly inspection: WorkjetLegacyImportInspection | null;
  readonly isInitialLoading: boolean;
  readonly hasInspectFailure: boolean;
  readonly isRefreshing: boolean;
  readonly isDeciding: boolean;
  /** A refusal from the server, already turned into operator-facing text. */
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onAccept: (bindings: WorkjetLegacyImportBindings) => void;
  readonly onDecline: () => void;
}

const TRANSPORT_LABELS: Readonly<Record<string, string>> = {
  Lokal: "Local",
  Tailscale: "Tailscale",
  SSH: "SSH",
};

const BLOCKED_BY_LABELS: Readonly<Record<string, string>> = {
  computer: "its computer is not bound",
  "llm-route": "its provider account or pool is not bound",
  "invalid-record": "the record itself is not importable",
};

export function legacyImportDecidedDescription(
  inspection: Extract<WorkjetLegacyImportInspection, { readonly state: "already-decided" }>,
): string {
  const when =
    inspection.decidedAt === null ? "at an unrecorded time" : `on ${inspection.decidedAt}`;
  return inspection.outcome === "declined"
    ? `You declined this import ${when}. The offer is not shown again.`
    : `Imported ${when}: ${inspection.importedComputers} computer(s), ${inspection.importedLlmRoutes} LLM route(s), ${inspection.importedWorkerProfiles} worker(s). ${inspection.pendingAtImport} record(s) were left unbound and not imported.`;
}

function BindingControl({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      value={value ?? null}
      onValueChange={(next) => onChange(typeof next === "string" ? next : "")}
    >
      <SelectTrigger aria-label={label} disabled={disabled} className="w-72">
        <SelectValue>{selected?.label ?? "Choose…"}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function PendingRecord({
  record,
  answer,
  bindable,
  disabled,
  onAnswer,
}: {
  readonly record: Exclude<WorkjetLegacyImportPending, { readonly kind: "worker" }>;
  readonly answer: WorkjetLegacyImportAnswer | undefined;
  readonly bindable: WorkjetLegacyImportBindableTargets;
  readonly disabled: boolean;
  readonly onAnswer: (key: string, answer: WorkjetLegacyImportAnswer) => void;
}) {
  const key = legacyImportRecordKey(record);
  const isSkipped = answer?._tag === "skip";
  const selected = isSkipped ? WORKJET_LEGACY_IMPORT_SKIP_VALUE : answer?.targetId;
  const handle = (value: string) =>
    onAnswer(
      key,
      value === WORKJET_LEGACY_IMPORT_SKIP_VALUE
        ? { _tag: "skip" }
        : { _tag: "bind", targetId: value },
    );

  const skipOption = { value: WORKJET_LEGACY_IMPORT_SKIP_VALUE, label: "Do not import this" };

  if (record.kind === "computer-environment") {
    const options = [
      ...bindable.environments.map((environment) => ({
        value: environment.environmentId as string,
        label: environment.isSelf
          ? `${environment.environmentId} (this server)`
          : environment.environmentId,
      })),
      skipOption,
    ];
    return (
      <SettingsRow
        title={`Computer · ${record.computerName}`}
        description={`${TRANSPORT_LABELS[record.transport] ?? record.transport}${record.host === null ? "" : ` · ${record.host}`} · ${record.computerId}. The legacy connection details are never imported; choose the Code environment this machine already is.`}
        status={
          isSkipped ? (
            <span>{WORKJET_LEGACY_IMPORT_SKIP_NOTICE}</span>
          ) : bindable.environments.length === 0 ? (
            <span role="alert">
              This server can verify no environment for this machine yet. Add it as a computer
              first, or skip it.
            </span>
          ) : undefined
        }
        control={
          <BindingControl
            label={`Code environment for ${record.computerName}`}
            value={selected}
            options={options}
            disabled={disabled}
            onChange={handle}
          />
        }
      />
    );
  }

  const accountOptions = [
    ...bindable.gatewayAccounts.map((account) => ({
      value: account.accountId as string,
      label:
        account.credentialSuffix === null
          ? `${account.label} · ${account.provider}`
          : `${account.label} · ${account.provider} · …${account.credentialSuffix}`,
    })),
    skipOption,
  ];

  if (record.kind === "provider-account") {
    const evidence = [
      record.modelProvider,
      record.accountLabel,
      record.externalCredentialId === null ? null : `CLIProxy ${record.externalCredentialId}`,
      record.modelIds.length === 0 ? null : record.modelIds.join(", "),
    ].filter((part): part is string => part !== null);
    return (
      <SettingsRow
        title={`Provider · ${record.providerName}`}
        description={`${evidence.join(" · ")}. Neither the legacy id nor the CLIProxy account hash is a gateway account id, so choose the gateway account this provider really was.`}
        status={
          isSkipped ? (
            <span>{WORKJET_LEGACY_IMPORT_SKIP_NOTICE}</span>
          ) : !bindable.gatewayCatalogAvailable ? (
            <span role="alert">
              The provider gateway is unavailable, so no account can be verified right now.
            </span>
          ) : undefined
        }
        control={
          <BindingControl
            label={`Gateway account for ${record.providerName}`}
            value={selected}
            options={accountOptions}
            disabled={disabled}
            onChange={handle}
          />
        }
      />
    );
  }

  return (
    <SettingsRow
      title={`Pool · ${record.pool}`}
      description={`${record.workerIds.length} worker(s) route through this legacy pool.`}
      status={
        <span role="alert" className="flex items-start gap-1.5">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {isSkipped
            ? `${WORKJET_LEGACY_IMPORT_SKIP_NOTICE} ${WORKJET_LEGACY_IMPORT_FAILOVER_NOTICE}`
            : WORKJET_LEGACY_IMPORT_FAILOVER_NOTICE}
        </span>
      }
      control={
        <BindingControl
          label={`Gateway account for pool ${record.pool}`}
          value={selected}
          options={accountOptions}
          disabled={disabled}
          onChange={handle}
        />
      }
    />
  );
}

export function WorkjetLegacyImportSectionView({
  state,
  draft,
  onAnswer,
}: {
  readonly state: WorkjetLegacyImportSectionState;
  readonly draft: WorkjetLegacyImportDraft;
  readonly onAnswer: (key: string, answer: WorkjetLegacyImportAnswer) => void;
}) {
  const section = searchableSetting("workjet-legacy-import");
  const inspection = state.inspection;

  const header = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={state.isRefreshing || state.isDeciding}
      onClick={state.onRefresh}
    >
      {state.isRefreshing ? (
        <Spinner className="size-3.5" />
      ) : (
        <RefreshCwIcon className="size-3.5" />
      )}
      Re-check
    </Button>
  );

  if (state.isInitialLoading || inspection === null) {
    return (
      <SettingsSection id={section.id} title={section.title} headerAction={header}>
        <SettingsRow
          title={state.hasInspectFailure ? "The import offer could not be read" : "Checking…"}
          description={
            state.hasInspectFailure
              ? "This server could not answer whether a legacy Workjet configuration exists. Nothing was changed."
              : "Asking this server whether the Swift app left a configuration on its machine."
          }
          status={state.hasInspectFailure ? <span role="alert">Read failed</span> : undefined}
        />
      </SettingsSection>
    );
  }

  if (inspection.state === "nothing-to-import") {
    return (
      <SettingsSection id={section.id} title={section.title} headerAction={header}>
        <SettingsRow
          title="Nothing to import"
          description="This server's machine has no legacy Swift Workjet configuration. The offer only appears on a machine that actually ran the Swift menu-bar app."
        />
      </SettingsSection>
    );
  }

  if (inspection.state === "already-decided") {
    return (
      <SettingsSection id={section.id} title={section.title} headerAction={header}>
        <SettingsRow
          title={inspection.outcome === "imported" ? "Already imported" : "Import declined"}
          description={legacyImportDecidedDescription(inspection)}
          status={
            <span className="flex items-center gap-1.5">
              <CheckCircle2Icon className="size-3.5 text-success" />
              Recorded once. This offer is terminal and is not shown again.
            </span>
          }
        />
        {inspection.legacyPath === null ? null : (
          <SettingsRow
            title="Legacy document"
            description={`${inspection.legacyPath} — never modified, moved, or deleted by the import.`}
          />
        )}
      </SettingsSection>
    );
  }

  if (inspection.state === "unreadable") {
    return (
      <SettingsSection id={section.id} title={section.title} headerAction={header}>
        <SettingsRow
          title="The legacy configuration could not be read"
          description={
            inspection.failure === null
              ? `${inspection.legacyPath} exists but could not be read at all. Nothing was recorded, so the offer returns once the file is readable.`
              : `${inspection.legacyPath}: ${inspection.failure.detail}${inspection.failure.path === null ? "" : ` (at ${inspection.failure.path})`}`
          }
          status={
            <span role="alert" className="flex items-start gap-1.5">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {inspection.failure === null
                ? "Unreadable file"
                : `Refused: ${inspection.failure.reason}`}
              . This is a defect to look at, not a decision — no marker was written and nothing was
              imported.
            </span>
          }
        />
      </SettingsSection>
    );
  }

  const accept = legacyImportAcceptState(inspection.pending, draft);
  const bindable = legacyImportBindableRecords(inspection.pending);
  const workers = inspection.pending.filter((record) => record.kind === "worker");
  const busy = state.isDeciding;

  return (
    <>
      <SettingsSection id={section.id} title={section.title} headerAction={header}>
        <SettingsRow
          title="A legacy Workjet configuration is waiting for one decision"
          description={`${inspection.legacyPath} → ${inspection.settingsPath}. It is read only: the import never modifies, moves, or deletes the legacy document, and it runs exactly once — accepting or declining is recorded and never offered again.`}
          status={
            <span>
              {inspection.summary.computersTotal} computer(s), {inspection.summary.workersTotal}{" "}
              worker(s) in the document. {inspection.summary.pendingTotal} record(s) need a decision
              below, and {inspection.summary.dropTotal} field(s) will not come across.
            </span>
          }
        />
        {state.error === null ? null : (
          <SettingsRow
            title="The server refused this import"
            description="Nothing was written: no settings were changed and no decision was recorded."
            status={
              <span role="alert" className="flex items-start gap-1.5">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {state.error}
              </span>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection
        title={`Records that need you (${accept.answeredCount}/${accept.bindableCount} answered)`}
      >
        {bindable.length === 0 ? (
          <SettingsRow
            title="Nothing to bind"
            description="Every record in this document maps without an operator decision."
          />
        ) : (
          bindable.map((record) => (
            <PendingRecord
              key={legacyImportRecordKey(record)}
              record={record}
              answer={draft[legacyImportRecordKey(record)]}
              bindable={inspection.bindable}
              disabled={busy}
              onAnswer={onAnswer}
            />
          ))
        )}
        {workers.length === 0 ? null : (
          <SettingsRow
            title={`${workers.length} worker(s) follow from the choices above`}
            description={workers
              .map((worker) =>
                worker.kind === "worker"
                  ? `${worker.workerName} — ${BLOCKED_BY_LABELS[worker.blockedBy] ?? worker.blockedBy}`
                  : "",
              )
              .join(" · ")}
            status={
              <span>
                These are consequences, not choices: a worker imports as soon as the record it
                depends on is bound, and stays out when that record is skipped.
              </span>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={`What will not come across (${inspection.drops.length})`}>
        <SettingsRow
          title="Fields the import deliberately leaves behind"
          description="Transport details, observed status, Swift-internal flags, and anything a newer Swift build added that this reader does not model. None of it reaches settings.workjet."
          status={
            inspection.dropsTruncated ? (
              <span role="alert">The list is longer than shown.</span>
            ) : undefined
          }
        />
        <div className="max-h-72 overflow-y-auto px-3 pb-3 sm:px-4">
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            {inspection.drops.map((drop) => (
              <li key={`${drop.kind}:${drop.source}`}>
                <span className="font-mono text-foreground">{drop.source}</span>
                {drop.kind === "unmapped-field" ? " (not modelled) " : " "}— {drop.reason}
              </li>
            ))}
          </ul>
        </div>
      </SettingsSection>

      <SettingsSection title="Decide">
        <SettingsRow
          title="Import this configuration"
          description={
            accept.canAccept
              ? `${accept.boundCount} record(s) bound, ${accept.skippedCount} skipped and not imported. This writes settings.workjet once and records the decision.`
              : `Answer every record first: ${accept.unansweredCount} of ${accept.bindableCount} still has no choice. Binding or skipping are both answers.`
          }
          status={
            accept.canAccept ? undefined : (
              <span role="alert">
                Accept stays disabled until every record above is bound or explicitly skipped.
              </span>
            )
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={state.onDecline}
              >
                Decline
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!accept.canAccept || busy}
                onClick={() =>
                  state.onAccept(legacyImportDecideBindings(inspection.pending, draft))
                }
              >
                {busy ? <Spinner className="size-3.5" /> : null}
                Import once
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Declining is also final"
          description="A decline is recorded with its date and the offer is never shown again. The legacy document itself is left untouched either way."
        />
      </SettingsSection>
    </>
  );
}
