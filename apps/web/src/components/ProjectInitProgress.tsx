import { useEffect, useState } from "react";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import type { CtoxWorkjetProjectInitStep } from "@workjet/contracts";
import {
  clearProjectInit,
  pendingProjectInit,
  presentProjectInitStep,
  requestProjectInit,
  type ProjectInitTone,
} from "../projectInit";
import { workjetUiLanguage } from "../workjetProjectControl";
import { Spinner } from "./ui/spinner";

const POLL_MS = 15_000;

/**
 * Native truth overrides queued CTOX steps: KPIs count as done once prompts
 * exist, the exit step once an assessment left "not_started".
 */
export function resolveProjectInitSteps(
  steps: readonly CtoxWorkjetProjectInitStep[],
  observed: { readonly kpiCount: number; readonly exitStatus: string | null },
): CtoxWorkjetProjectInitStep[] {
  return steps.map((step) => {
    if (step.id === "kpis" && observed.kpiCount > 0) return { ...step, state: "done" };
    if (step.id === "exit" && observed.exitStatus !== null && observed.exitStatus !== "not_started")
      return {
        ...step,
        state:
          observed.exitStatus === "researching"
            ? "queued"
            : observed.exitStatus === "blocked"
              ? "blocked"
              : "done",
        detail: observed.exitStatus === "blocked" ? "exit_inputs_missing" : step.detail,
      };
    return step;
  });
}

export function useProjectInit(instanceId: string | null, projectId: string) {
  const [steps, setSteps] = useState<readonly CtoxWorkjetProjectInitStep[] | null>(null);
  const [failed, setFailed] = useState(false);
  const operationId = instanceId ? pendingProjectInit(instanceId, projectId) : null;
  useEffect(() => {
    if (!instanceId || !operationId) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const result = await requestProjectInit(instanceId, projectId, operationId);
      if (stale) return;
      if (result._tag === "completed") {
        setFailed(false);
        setSteps(result.steps);
      } else setFailed(true);
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
    };
  }, [instanceId, projectId, operationId]);
  return { active: operationId !== null, steps, failed };
}

function ToneIcon({ tone }: { readonly tone: ProjectInitTone }) {
  if (tone === "done") return <CheckIcon className="size-3 text-success" aria-hidden="true" />;
  if (tone === "running") return <Spinner className="size-3" aria-hidden="true" />;
  return <CircleAlertIcon className="size-3 text-warning" aria-hidden="true" />;
}

/** One compact line of onboarding steps on the new project card. */
export function ProjectInitProgress({
  instanceId,
  projectId,
  kpiCount,
  exitStatus,
}: {
  readonly instanceId: string | null;
  readonly projectId: string;
  readonly kpiCount: number;
  readonly exitStatus: string | null;
}) {
  const en = workjetUiLanguage() === "en";
  const { active, steps, failed } = useProjectInit(instanceId, projectId);
  const resolved = steps ? resolveProjectInitSteps(steps, { kpiCount, exitStatus }) : null;
  const settled = resolved !== null && resolved.every((step) => step.state === "done");
  useEffect(() => {
    if (settled && instanceId) clearProjectInit(instanceId, projectId);
  }, [settled, instanceId, projectId]);
  if (!active || settled) return null;
  return (
    <div
      className="border-t border-border px-3 py-2 text-xs"
      data-workjet-project-init={projectId}
      aria-live="polite"
    >
      {resolved === null ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {failed ? (
            <CircleAlertIcon className="size-3 text-warning" aria-hidden="true" />
          ) : (
            <Spinner className="size-3" aria-hidden="true" />
          )}
          {failed
            ? en
              ? "Setup not reachable"
              : "Einrichtung nicht erreichbar"
            : en
              ? "Setting up project"
              : "Projekt wird eingerichtet"}
        </span>
      ) : (
        <ol className="flex flex-wrap gap-x-3 gap-y-1">
          {resolved.map((step) => {
            const view = presentProjectInitStep(step, en);
            return (
              <li
                key={step.id}
                className="flex items-center gap-1 text-muted-foreground"
                data-workjet-project-init-step={step.id}
                data-state={view.tone}
                title={view.note ?? undefined}
              >
                <ToneIcon tone={view.tone} />
                <span className={view.tone === "done" ? "text-foreground" : undefined}>
                  {view.label}
                </span>
                {view.note ? <span className="text-warning">· {view.note}</span> : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
