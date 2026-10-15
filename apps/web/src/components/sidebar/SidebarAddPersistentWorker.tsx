/**
 * Plus unter „Persistente Worker“ (Michael, 15.10.): legt einen persistenten
 * Worker an, inline am Klickort. Derselbe Anlegeweg wie „Worker hinzufügen“
 * in der Projektübersicht: Thread mit `createPersistentWorkerConfig` unter dem
 * Supervisor des Projekts.
 */
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { newThreadId } from "~/lib/utils";
import { resolveProjectTeamModelSelection } from "../../providerInstances";
import { createPersistentWorkerConfig } from "../../routes/-projectWorkerConfig";
import { useEnvironments } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { InlinePanel } from "../ui/inline-panel";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarAddPersistentWorkerText {
  readonly addPersistentWorker: string;
  readonly name: string;
  readonly goal: string;
  readonly saving: string;
  readonly create: string;
  readonly addFailed: string;
}

/** Legt einen persistenten Worker unter dem Supervisor an; false bei Fehler. */
export function useAddPersistentWorker(
  supervisor: EnvironmentThreadShell | null,
): ((domain: string, goal: string) => Promise<boolean>) | null {
  const { environments } = useEnvironments();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const create = useCallback(
    async (domain: string, goal: string) => {
      if (
        !supervisor ||
        supervisor.workjetConfig.schemaVersion !== 2 ||
        supervisor.workjetConfig.team?.role !== "supervisor"
      )
        return false;
      const modelSelection = resolveProjectTeamModelSelection(
        environments.find((environment) => environment.environmentId === supervisor.environmentId)
          ?.serverConfig?.providers ?? [],
        supervisor.modelSelection,
      );
      if (!modelSelection) return false;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const result = await createThread({
        environmentId: supervisor.environmentId,
        input: {
          threadId,
          projectId: supervisor.projectId,
          title: domain,
          modelSelection,
          runtimeMode: supervisor.runtimeMode,
          interactionMode: "default",
          workjetConfig: createPersistentWorkerConfig({
            supervisorConfig: supervisor.workjetConfig,
            projectId: supervisor.projectId,
            supervisorThreadId: supervisor.id,
            threadId,
            domain,
            goal,
            createdAt,
          }),
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      return result._tag === "Success";
    },
    [createThread, environments, supervisor],
  );
  return supervisor === null ? null : create;
}

/** Plus-Icon und das aufklappende Formular (Name, Ziel) direkt darunter. */
export function SidebarAddPersistentWorker(props: {
  readonly text: SidebarAddPersistentWorkerText;
  readonly onCreate: (domain: string, goal: string) => Promise<boolean>;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  const [domain, setDomain] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async () => {
    if (saving || !domain.trim() || !goal.trim()) return;
    setSaving(true);
    setFailed(false);
    try {
      if (await props.onCreate(domain.trim(), goal.trim())) {
        setOpen(false);
        setDomain("");
        setGoal("");
      } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 px-1 py-0.5" data-sidebar-add-persistent-worker="">
      {open ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={props.text.addPersistentWorker}
                data-workjet-action="project.worker.persistent.add"
                className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                onClick={() => setOpen(true)}
              />
            }
          >
            <PlusIcon aria-hidden className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="right">{props.text.addPersistentWorker}</TooltipPopup>
        </Tooltip>
      )}
      <InlinePanel
        hideTrigger
        triggerLabel={props.text.addPersistentWorker}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailed(false);
        }}
        submitLabel={saving ? props.text.saving : props.text.create}
        submitDisabled={!domain.trim() || !goal.trim()}
        busy={saving}
        status={failed ? props.text.addFailed : undefined}
        statusTone="error"
        onSubmit={() => void submit()}
        className="text-[13.5px] text-foreground"
      >
        <label className="grid gap-1 text-[13.5px]">
          {props.text.name}
          <Input
            required
            autoFocus
            maxLength={256}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[13.5px]">
          {props.text.goal}
          <Textarea
            required
            maxLength={4096}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            className="min-h-20"
          />
        </label>
      </InlinePanel>
    </div>
  );
}
