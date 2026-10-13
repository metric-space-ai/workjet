/**
 * One-click onboarding (ctox.workjet.project.init, ctox #653). The project is
 * created first; then this module calls init with a stable operation id and
 * re-calls it for progress. CTOX derives every sub-command from that id, so a
 * re-call never starts a second exit evaluation or Supervisor turn.
 */
import { ProjectId, type CtoxWorkjetProjectInitStep } from "@workjet/contracts";
import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";
import { newCommandId } from "./lib/utils";

const STORAGE_KEY = "workjet:project-init:v1";
/** Onboarding progress stays on the card for at most one day. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Pending = Record<string, { readonly operationId: string; readonly startedAt: number }>;

function pendingKey(instanceId: string, projectId: string): string {
  return `${instanceId}\u0000${projectId}`;
}

function readPending(storage: Storage | undefined, now: number): Pending {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Pending) : {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, entry]) =>
          typeof entry?.operationId === "string" &&
          typeof entry.startedAt === "number" &&
          now - entry.startedAt < MAX_AGE_MS,
      ),
    );
  } catch {
    return {};
  }
}

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Mark a freshly created project; the card then shows and polls its onboarding. */
export function markProjectInitPending(
  instanceId: string,
  projectId: string,
  storage: Storage | undefined = browserStorage(),
  now = Date.now(),
): string {
  const pending = readPending(storage, now);
  const key = pendingKey(instanceId, projectId);
  const operationId = pending[key]?.operationId ?? `project-init:${projectId}`;
  pending[key] = { operationId, startedAt: pending[key]?.startedAt ?? now };
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Without storage the card only loses progress after a reload.
  }
  return operationId;
}

export function pendingProjectInit(
  instanceId: string,
  projectId: string,
  storage: Storage | undefined = browserStorage(),
  now = Date.now(),
): string | null {
  return readPending(storage, now)[pendingKey(instanceId, projectId)]?.operationId ?? null;
}

export function clearProjectInit(
  instanceId: string,
  projectId: string,
  storage: Storage | undefined = browserStorage(),
  now = Date.now(),
): void {
  const pending = readPending(storage, now);
  delete pending[pendingKey(instanceId, projectId)];
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // ignore
  }
}

export type ProjectInitResult =
  | { readonly _tag: "completed"; readonly steps: readonly CtoxWorkjetProjectInitStep[] }
  | { readonly _tag: "failed"; readonly code: string };

export async function requestProjectInit(
  instanceId: string,
  projectId: string,
  operationId: string,
  port?: WorkjetProjectControlPort,
): Promise<ProjectInitResult> {
  const commandId = newCommandId();
  try {
    const result = await requestWorkjetProjectControl(
      instanceId,
      { action: "project.init", commandId, projectId: ProjectId.make(projectId), operationId },
      port,
    );
    if (result._tag !== "completed") return { _tag: "failed", code: result.code };
    const response = result.response;
    if (
      response.action !== "project.init" ||
      response.commandId !== commandId ||
      response.projectId !== projectId
    )
      return { _tag: "failed", code: "guest_failed" };
    return { _tag: "completed", steps: response.steps };
  } catch {
    return { _tag: "failed", code: "guest_failed" };
  }
}

export type ProjectInitTone = "done" | "running" | "blocked" | "failed";

const STEP_LABELS: Record<string, { de: string; en: string }> = {
  analysed: { de: "Analyse", en: "Analysis" },
  regeltermin: { de: "Regeltermin", en: "Regular meeting" },
  exit: { de: "Exit-Bewertung", en: "Exit valuation" },
  supervisor: { de: "Supervisor", en: "Supervisor" },
  kpis: { de: "KPIs", en: "KPIs" },
  worker: { de: "Erster Worker", en: "First worker" },
};

/** Map CTOX reasons to the one short fact the owner can act on. */
function blockedReason(detail: string, en: boolean): string {
  const text = detail.toLowerCase();
  if (text.includes("exit_inputs_missing")) return en ? "Inputs missing" : "Angaben fehlen";
  if (text.includes("supervisor_not_bound"))
    return en ? "Supervisor not set up yet" : "Supervisor noch nicht eingerichtet";
  if (/model|provider|account|credential/.test(text))
    return en ? "Model account missing" : "Modell-Konto fehlt";
  if (/permission|policy|denied/.test(text)) return en ? "No permission" : "Keine Berechtigung";
  return en ? "Failed" : "Fehlgeschlagen";
}

export function presentProjectInitStep(
  step: CtoxWorkjetProjectInitStep,
  en: boolean,
): { readonly label: string; readonly tone: ProjectInitTone; readonly note: string | null } {
  const label = STEP_LABELS[step.id]?.[en ? "en" : "de"] ?? step.id;
  if (step.state === "done") return { label, tone: "done", note: null };
  if (step.state === "queued" || step.state === "running")
    return { label, tone: "running", note: null };
  return {
    label,
    tone: step.state === "blocked" ? "blocked" : "failed",
    note: blockedReason(step.detail, en),
  };
}

/** Onboarding is settled when nothing is still queued in CTOX. */
export function projectInitSettled(steps: readonly CtoxWorkjetProjectInitStep[]): boolean {
  return steps.length > 0 && steps.every((step) => step.state === "done");
}
