import {
  WorkjetExitModelAssessment,
  WorkjetExitModelResponse,
  type CtoxWorkjetProjectControlRequest,
  type WorkjetExitModelStatus,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

export type ExitModelRequest = Extract<
  CtoxWorkjetProjectControlRequest,
  { readonly action: "project.exit_model.read" | "project.exit_model.refresh" }
>;

const isAssessment = Schema.is(WorkjetExitModelAssessment);
const isResponse = Schema.is(WorkjetExitModelResponse);

export async function requestProjectExitModel(
  instanceId: string,
  request: ExitModelRequest,
  port?: WorkjetProjectControlPort,
): Promise<
  | { readonly _tag: "completed"; readonly assessment: WorkjetExitModelAssessment }
  | { readonly _tag: "failed"; readonly message: string }
> {
  try {
    const result = await requestWorkjetProjectControl(instanceId, request, port);
    if (result._tag !== "completed") {
      const unavailable = result.code === "unsupported" || result.code === "guest_failed";
      return {
        _tag: "failed",
        message: unavailable
          ? "The exit assessment service is unavailable. Update or reconnect this instance."
          : "The assessment could not be loaded. Reconnect this instance and try again.",
      };
    }
    const response = result.response;
    if (
      !isResponse(response) ||
      response.action !== request.action ||
      response.commandId !== request.commandId ||
      response.projectId !== request.projectId
    )
      return {
        _tag: "failed",
        message: "The assessment receipt did not match this project request.",
      };
    return { _tag: "completed", assessment: response.assessment };
  } catch {
    return { _tag: "failed", message: "The assessment could not be loaded. Try again." };
  }
}

export const EXIT_MODEL_STATUS_LABELS: Record<WorkjetExitModelStatus, string> = {
  not_started: "Not assessed",
  researching: "Research in progress",
  blocked: "Inputs needed",
  provisional: "Provisional",
  ready: "Assessed",
  failed: "Assessment failed",
};

export function formatExitMissingInput(
  input: string,
  assessment?: WorkjetExitModelAssessment | null,
): string {
  const labels: Record<string, string> = {
    resource_plan: "Resource plan",
    resource_proposal: "Hours and budget available to this project",
    confirmed_resource_plan: "Owner-confirmed resource plan",
    confirmed_60_month_resource_plan: "Owner-confirmed monthly plan for five years",
    supported_committed_plan: "Plan based on resources already committed",
    research_inputs: "Researched operating and sale assumptions",
    researched_inputs: "Researched operating and sale assumptions",
    valid_source_backed_research_inputs: "Operating and sale assumptions supported by evidence",
    sale_perimeter: "Defined equity sale scope",
    transferable_rights: "Transferable ownership, IP and licence rights",
    supported_adapter: "Valuation model suitable for this project's business",
    "source:plan": "Evidence for the resource plan",
    "source:sale_perimeter": "Evidence for ownership and sale scope",
    "source:probabilities": "Evidence for scenario and sale probabilities",
  };
  if (labels[input]) return labels[input];
  if (input.startsWith("current_source:")) {
    const id = input.slice("current_source:".length);
    const source = assessment?.sources.find((item) => item.id === id);
    return "Current evidence: " + (source?.reference ?? id);
  }
  if (input.startsWith("source:")) return "Evidence reference: " + input.slice("source:".length);
  return input.replaceAll("_", " ");
}

export function formatExitFinding(finding: {
  readonly code: string;
  readonly message: string;
}): string {
  const labels: Record<string, string> = {
    resource_or_supervisor_missing:
      "Add a resource plan and connect this project to its supervisor.",
    required_inputs_missing: "Complete the missing inputs to calculate a forecast.",
    research_admitted: "The project's supervisor is gathering inputs.",
    research_did_not_supply_valid_inputs: "Research finished with missing or unverified inputs.",
    evidence_not_independently_verified:
      "The evidence and assumptions have not been independently reviewed.",
  };
  return labels[finding.code] ?? finding.message;
}

export function calendarDateToday(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

export function exitModelPresentation(
  assessment: WorkjetExitModelAssessment | null | undefined,
  projectId: string,
  today: string = calendarDateToday(),
) {
  if (assessment == null)
    return {
      status: "not_started" as const,
      label: "Not assessed",
      value: "—",
      stale: false,
      assessment: null,
      change: null,
    };
  if (!isAssessment(assessment) || assessment.project_id !== projectId)
    return {
      status: "failed" as const,
      label: "Assessment unavailable",
      value: "—",
      stale: false,
      assessment: null,
      change: null,
    };
  const result = assessment.result;
  const stale =
    result !== null &&
    ((assessment.refresh_due !== null && assessment.refresh_due <= today) ||
      assessment.sources.some((source) => source.valid_until < today));
  return {
    status: assessment.status,
    label: stale ? "Out of date" : EXIT_MODEL_STATUS_LABELS[assessment.status],
    value: result === null ? "—" : formatExitEur(result.expected_exit_equity_eur),
    stale,
    assessment,
    change: exitModelChange(assessment),
  };
}

/** Carries PR #204's guarded comparison into the persisted assessment history. */
export function exitModelChange(assessment: WorkjetExitModelAssessment) {
  const current = assessment.result?.expected_exit_equity_eur;
  if (current == null || !Number.isFinite(current) || current < 0) return null;
  // The authority returns newest first, including the current run. Pending or
  // incomplete runs have no calculated baseline; never relabel them as a value.
  const previous = assessment.history.find(
    (run) => run.run_id !== assessment.run_id && run.result !== null,
  );
  const amount = previous?.result?.expected_exit_equity_eur;
  if (
    !previous ||
    amount == null ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !assessment.as_of ||
    previous.as_of > assessment.as_of
  )
    return null;
  const percent = ((current - amount) / amount) * 100;
  return Number.isFinite(percent) ? { percent, asOf: previous.as_of } : null;
}

export function formatExitChange(percent: number): string {
  return (
    new Intl.NumberFormat("en-GB", {
      signDisplay: "exceptZero",
      maximumFractionDigits: 1,
    }).format(percent) + "%"
  );
}

/** Display precision follows the forecast scale; stored calculations retain full precision. */
export function formatExitEur(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000)
    return (
      new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value / 1_000_000) +
      "m EUR"
    );
  if (value >= 1_000)
    return (
      new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value / 1_000) + "k EUR"
    );
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value) + " EUR";
}

export function formatExitPercent(value: number): string {
  return new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatExitDate(value: string | null): string {
  return value === null
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(value + "T00:00:00Z"));
}

export function exitSourceUrl(reference: string): string | null {
  try {
    const url = new URL(reference);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}
