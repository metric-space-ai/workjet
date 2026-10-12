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
        message: unavailable ? "Bewertungsdienst nicht verfügbar." : "Bewertung nicht geladen.",
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
        message: "Antwort passt nicht zum Projekt.",
      };
    return { _tag: "completed", assessment: response.assessment };
  } catch {
    return { _tag: "failed", message: "Bewertung nicht geladen." };
  }
}

export const EXIT_MODEL_STATUS_LABELS: Record<WorkjetExitModelStatus, string> = {
  not_started: "Nicht bewertet",
  researching: "Recherche läuft",
  blocked: "Angaben fehlen",
  provisional: "Vorläufig",
  ready: "Bewertet",
  failed: "Bewertung fehlgeschlagen",
};

export function formatExitMissingInput(
  input: string,
  assessment?: WorkjetExitModelAssessment | null,
): string {
  const labels: Record<string, string> = {
    resource_plan: "Ressourcenplan",
    resource_proposal: "Verfügbare Stunden und Budget",
    confirmed_resource_plan: "Bestätigter Ressourcenplan",
    confirmed_60_month_resource_plan: "Bestätigter Monatsplan für fünf Jahre",
    supported_committed_plan: "Plan aus zugesagten Ressourcen",
    research_inputs: "Recherchierte Betriebs- und Verkaufsannahmen",
    researched_inputs: "Recherchierte Betriebs- und Verkaufsannahmen",
    valid_source_backed_research_inputs: "Belegte Betriebs- und Verkaufsannahmen",
    sale_perimeter: "Festgelegter Verkaufsumfang",
    transferable_rights: "Übertragbare Eigentums-, IP- und Lizenzrechte",
    supported_adapter: "Passendes Bewertungsmodell",
    "source:plan": "Beleg für den Ressourcenplan",
    "source:sale_perimeter": "Beleg für Eigentum und Verkaufsumfang",
    "source:probabilities": "Beleg für Wahrscheinlichkeiten",
  };
  if (labels[input]) return labels[input];
  if (input.startsWith("current_source:")) {
    const id = input.slice("current_source:".length);
    const source = assessment?.sources.find((item) => item.id === id);
    return "Aktueller Beleg: " + (source?.reference ?? id);
  }
  if (input.startsWith("source:")) return "Belegverweis: " + input.slice("source:".length);
  return input.replaceAll("_", " ");
}

export function formatExitFinding(finding: {
  readonly code: string;
  readonly message: string;
}): string {
  const labels: Record<string, string> = {
    resource_or_supervisor_missing: "Ressourcenplan oder Supervisor fehlt.",
    required_inputs_missing: "Angaben für die Prognose fehlen.",
    research_admitted: "Supervisor sammelt Angaben.",
    research_did_not_supply_valid_inputs:
      "Recherche mit fehlenden oder ungeprüften Angaben beendet.",
    evidence_not_independently_verified: "Belege und Annahmen nicht unabhängig geprüft.",
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
      label: "Nicht bewertet",
      value: "—",
      stale: false,
      assessment: null,
      change: null,
    };
  if (!isAssessment(assessment) || assessment.project_id !== projectId)
    return {
      status: "failed" as const,
      label: "Bewertung nicht verfügbar",
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
    label: stale ? "Veraltet" : EXIT_MODEL_STATUS_LABELS[assessment.status],
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
  return new Intl.NumberFormat("de-DE", {
    style: "percent",
    signDisplay: "exceptZero",
    maximumFractionDigits: 1,
  }).format(percent / 100);
}

/** Display precision follows the forecast scale; stored calculations retain full precision. */
export function formatExitEur(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  const forecast = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
  if (value >= 1_000_000) return forecast.format(value / 1_000_000) + "\u00A0Mio.\u00A0€";
  if (value >= 1_000) return forecast.format(value / 1_000) + "\u00A0Tsd.\u00A0€";
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value) + "\u00A0€";
}

/** Eingabe „Std./Woche": ganze Zahl von 0 bis 168, leer oder ungültig → null. */
export function parseExitHoursPerWeek(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 168) return null;
  return value;
}

/** Eingabe „€/Monat": endliche Zahl ≥ 0, leer oder ungültig → null. */
export function parseExitMonthlyBudget(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function formatExitPercent(value: number): string {
  return new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatExitDate(value: string | null): string {
  return value === null
    ? "—"
    : new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit",
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
