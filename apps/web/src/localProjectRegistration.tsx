import type { CtoxProjectRegistration, OrchestrationProjectShell } from "@workjet/contracts";
import { useEffect, useRef, useState } from "react";
import {
  useActiveWorkjetScope,
  readActiveWorkjetScope,
  subscribeActiveWorkjetHostContext,
} from "./activeWorkjetScope";
import { useProjects } from "./state/entities";
import { usePrimaryEnvironmentId } from "./state/environments";
import { projectEnvironment } from "./state/projects";
import { useAtomCommand } from "./state/use-atom-command";
import {
  runWorkjetProjectCreation,
  workjetProjectCreationFailureMessage,
} from "./workjetProjectCreation";
import {
  recordWorkjetProjectProjection,
  resolveLocalWorkjetWorkingCopy,
  useWorkjetProjectRegistry,
} from "./workjetProjectRegistry";
import { Button } from "./components/ui/button";
import { usePrimarySettings } from "./hooks/useSettings";

const RETRY_EVENT = "workjet:retry-local-project-registration";

/** One bounded attempt per intent per connection/focus, using the persisted command identity. */
export function LocalProjectRegistrationSynchronizer() {
  const projects = useProjects();
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  const localEnvironmentId = usePrimaryEnvironmentId();
  const { selectedInstanceId, selectionRevision } = useActiveWorkjetScope();
  const registry = useWorkjetProjectRegistry(selectedInstanceId);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const attempted = useRef(new Set<string>());
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const retry = () => {
      attempted.current.clear();
      setGeneration((value) => value + 1);
    };
    const unsubscribeHostContext = subscribeActiveWorkjetHostContext(retry);
    window.addEventListener("focus", retry);
    window.addEventListener(RETRY_EVENT, retry);
    return () => {
      unsubscribeHostContext();
      window.removeEventListener("focus", retry);
      window.removeEventListener(RETRY_EVENT, retry);
    };
  }, []);

  useEffect(() => {
    attempted.current.clear();
    setGeneration((value) => value + 1);
  }, [selectedInstanceId, selectionRevision]);

  useEffect(() => {
    if (inFlight.current || selectedInstanceId === null || registry.phase === "loading") return;
    const project = projects.find((candidate) => {
      const intent = candidate.ctoxRegistration;
      return (
        candidate.environmentId === localEnvironmentId &&
        intent?.instanceId === selectedInstanceId &&
        intent.status === "pending" &&
        !attempted.current.has(intent.commandId)
      );
    });
    const intent = project?.ctoxRegistration;
    if (!project || !intent) return;
    attempted.current.add(intent.commandId);
    inFlight.current = true;
    void (async () => {
      try {
        const workingCopy =
          project.workspaceRoot === null
            ? null
            : resolveLocalWorkjetWorkingCopy({
                computers,
                resolvedComputer: null,
                localEnvironmentId,
                path: project.workspaceRoot,
              });
        if (project.workspaceRoot !== null && workingCopy === null) {
          await updateProject({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              ctoxRegistration: { ...intent, lastFailure: "local_computer_unregistered" },
            },
          });
          return;
        }
        const outcome = await runWorkjetProjectCreation({
          presentationInstanceId: intent.instanceId,
          request: {
            action: "project.create",
            commandId: intent.commandId,
            projectId: project.id,
            title: project.title,
            createdAt: project.createdAt,
            ...(workingCopy ? { workingCopy } : {}),
          },
        });
        const currentScope = readActiveWorkjetScope();
        if (
          !mounted.current ||
          currentScope.selectedInstanceId !== intent.instanceId ||
          currentScope.selectionRevision !== selectionRevision
        )
          return;
        // Keep the authoritative registry untouched until the native response is validated.
        const next: CtoxProjectRegistration =
          outcome._tag === "visible"
            ? { instanceId: intent.instanceId, commandId: intent.commandId, status: "confirmed" }
            : { ...intent, status: "pending", lastFailure: outcome.code };
        if (outcome._tag === "visible")
          recordWorkjetProjectProjection(intent.instanceId, outcome.project);
        await updateProject({
          environmentId: project.environmentId,
          input: { projectId: project.id, ctoxRegistration: next },
        });
      } finally {
        inFlight.current = false;
        if (mounted.current) setGeneration((value) => value + 1);
      }
    })().catch(() => {
      // An unacknowledged local update leaves the persisted intent pending.
    });
  }, [
    computers,
    generation,
    localEnvironmentId,
    projects,
    registry.phase,
    selectedInstanceId,
    selectionRevision,
    updateProject,
  ]);
  return null;
}

export function ProjectNativeSyncStatus({
  project,
}: {
  readonly project: OrchestrationProjectShell | null;
}) {
  const intent = project?.ctoxRegistration;
  if (!intent || intent.status === "confirmed") return null;
  return (
    <div
      role="status"
      data-workjet-project-sync="pending"
      className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm text-muted-foreground"
    >
      <span>Project saved locally · CTOX synchronization pending.</span>
      {intent.lastFailure ? (
        <span>{workjetProjectCreationFailureMessage(intent.lastFailure)}</span>
      ) : null}
      <Button
        variant="outline"
        size="xs"
        onClick={() => window.dispatchEvent(new Event(RETRY_EVENT))}
      >
        Retry sync
      </Button>
    </div>
  );
}
