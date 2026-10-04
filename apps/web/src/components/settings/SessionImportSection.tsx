import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@workjet/client-runtime/state/runtime";
import {
  WORKJET_SESSION_IMPORT_MAX_SELECTION,
  type EnvironmentId,
  type WorkjetSessionImportCandidate,
  type WorkjetSessionImportItemResult,
  type WorkjetSessionImportSource,
} from "@workjet/contracts";
import { ArrowRightIcon, FolderInputIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { readActiveWorkjetScope, useActiveWorkjetScope } from "../../activeWorkjetScope";
import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { newCommandId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  workjetProjectCreationFailureMessage,
  runWorkjetProjectCreation,
} from "../../workjetProjectCreation";
import { listWorkjetProjects } from "../../workjetProjectControl";
import {
  recordWorkjetProjectProjection,
  useWorkjetProjectRegistry,
} from "../../workjetProjectRegistry";
import { Button } from "../ui/button";
import { SessionImportBrowser, sessionImportFolderName } from "./SessionImportBrowser";
import { prepareSessionImportProject, type SessionImportProject } from "./sessionImportProject";
import { selectAllSessionImportCandidates } from "./sessionImportSelection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const PAGE_SIZE = 20;

export function SessionImportSection({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const navigate = useNavigate();
  const { selectedInstanceId: presentationInstanceId } = useActiveWorkjetScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useEnvironmentSettings(environmentId);
  const registry = useWorkjetProjectRegistry(presentationInstanceId);
  const localProjects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const computer = settings.workjet.computers.find(
    (entry) => entry.environmentId === environmentId,
  );
  const projects = useMemo<readonly SessionImportProject[]>(
    () =>
      presentationInstanceId === null
        ? localProjects.map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot }))
        : registry.projects.map((project) => ({
            id: project.id,
            title: project.title,
            workspaceRoot:
              localProjects.find(({ id }) => id === project.id)?.workspaceRoot ??
              project.workingCopies.find(
                (copy) => copy.computerId === computer?.id && copy.status === "active",
              )?.path ??
              "",
          })),
    [presentationInstanceId, registry.projects, localProjects, computer?.id],
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [source, setSource] = useState<WorkjetSessionImportSource | "all">("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlyMap<string, WorkjetSessionImportCandidate>>(
    () => new Map(),
  );
  const [preview, setPreview] = useState<WorkjetSessionImportCandidate | null>(null);
  const [destination, setDestination] = useState("");
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly WorkjetSessionImportItemResult[]>([]);
  const scopeKey = JSON.stringify([environmentId, presentationInstanceId]);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const mountedRef = useRef(true);
  const importingRef = useRef(false);
  const stoppedRef = useRef(false);
  const isActive = () =>
    mountedRef.current &&
    scopeRef.current === scopeKey &&
    readActiveWorkjetScope().selectedInstanceId === presentationInstanceId;
  const inspection = useEnvironmentQuery(
    open
      ? serverEnvironment.workjetSessionImport({
          environmentId,
          input: {
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
            query: debouncedQuery,
            ...(source === "all" ? {} : { source }),
          },
        })
      : null,
  );
  const inspectForSelection = useAtomCommand(serverEnvironment.inspectWorkjetSessions, {
    reportFailure: false,
  });
  const runImport = useAtomCommand(serverEnvironment.importWorkjetSessions, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const destinationProject = projects.find(({ id }) => id === destination);
  const canImport =
    selected.size > 0 &&
    !readOnly &&
    (destination === "new"
      ? !!newProjectTitle.trim() && !!workspaceRoot.trim()
      : !!destinationProject && !!(destinationProject.workspaceRoot || workspaceRoot.trim()));

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedQuery(query);
      setPage(0);
    }, 250);
    return () => clearTimeout(timeout);
  }, [query]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stoppedRef.current = true;
    };
  }, []);
  useEffect(() => {
    setOpen(false);
    setSelected(new Map());
    setPreview(null);
    setDestination("");
    setResults([]);
    setError(null);
    setProgress(null);
    setPage(0);
    setQuery("");
    setSource("all");
    setNewProjectTitle("");
    setWorkspaceRoot("");
    importingRef.current = false;
    stoppedRef.current = true;
  }, [scopeKey]);

  const selectAllMatches = async () => {
    if (readOnly || importingRef.current || !isActive()) return;
    importingRef.current = true;
    stoppedRef.current = false;
    setError(null);
    setProgress("Selecting conversations…");
    try {
      await selectAllSessionImportCandidates({
        query: debouncedQuery,
        source,
        isActive: () => isActive() && !stoppedRef.current,
        inspect: async (input) => {
          const result = await inspectForSelection({ environmentId, input });
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            throw failure instanceof Error
              ? failure
              : new Error("The conversations could not be selected. You can retry.");
          }
          return result.value;
        },
        onCandidates: (candidates, count) => {
          setSelected((current) => {
            const next = new Map(current);
            for (const candidate of candidates) next.set(candidate.candidateId, candidate);
            return next;
          });
          setProgress(`Selecting conversations… ${count} found`);
        },
      });
    } catch (cause) {
      if (isActive() && !stoppedRef.current)
        setError(cause instanceof Error ? cause.message : "The selection could not be completed.");
    } finally {
      if (isActive()) {
        importingRef.current = false;
        setProgress(null);
      }
    }
  };

  const importSelected = async () => {
    if (!canImport || importingRef.current || !isActive()) return;
    importingRef.current = true;
    stoppedRef.current = false;
    setError(null);
    setResults([]);
    setProgress("Preparing project…");
    const captured = [...selected.values()];
    try {
      const project = await prepareSessionImportProject({
        presentationInstanceId,
        environmentId,
        localProjects,
        destination:
          destination === "new"
            ? { kind: "new", title: newProjectTitle, workspaceRoot }
            : {
                kind: "existing",
                project: {
                  ...destinationProject!,
                  workspaceRoot: destinationProject!.workspaceRoot || workspaceRoot.trim(),
                },
              },
        port: {
          isActive,
          listLogicalProjects: async () => {
            const listed = await listWorkjetProjects(presentationInstanceId!);
            if (listed._tag === "failed")
              throw new Error(workjetProjectCreationFailureMessage(listed.code));
            if (listed.response.action !== "project.list")
              throw new Error("CTOX did not confirm the available projects.");
            return listed.response.projects;
          },
          createLocalProject: async (project) => {
            const created = await createProject({
              environmentId,
              input: {
                projectId: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
                createWorkspaceRootIfMissing: true,
                defaultModelSelection: resolveDefaultProviderModelSelection([], null),
              },
            });
            if (created._tag === "Failure") {
              const failure = squashAtomCommandFailure(created);
              throw failure instanceof Error
                ? failure
                : new Error("The destination project could not be created.");
            }
          },
          confirmLogicalProject: async (project) => {
            const confirmed = await runWorkjetProjectCreation({
              presentationInstanceId: presentationInstanceId!,
              request: {
                action: "project.create",
                commandId: newCommandId(),
                projectId: project.id,
                title: project.title,
                createdAt: new Date().toISOString(),
                ...(computer
                  ? { workingCopy: { computerId: computer.id, path: project.workspaceRoot } }
                  : {}),
              },
            });
            if (confirmed._tag === "failed")
              throw new Error(workjetProjectCreationFailureMessage(confirmed.code));
            if (!isActive())
              throw new Error("The active instance changed while preparing the project.");
            if (!recordWorkjetProjectProjection(presentationInstanceId!, confirmed.project))
              throw new Error("The project is not visible in the active CTOX instance yet.");
          },
        },
      });
      if (!isActive()) return;
      setDestination(project.id);
      const collected: WorkjetSessionImportItemResult[] = [];
      for (
        let offset = 0;
        offset < captured.length;
        offset += WORKJET_SESSION_IMPORT_MAX_SELECTION
      ) {
        if (!isActive() || stoppedRef.current) break;
        setProgress(
          `Importing ${offset + 1}–${Math.min(offset + WORKJET_SESSION_IMPORT_MAX_SELECTION, captured.length)} of ${captured.length}…`,
        );
        const result = await runImport({
          environmentId,
          input: {
            projectId: project.id,
            candidateIds: captured
              .slice(offset, offset + WORKJET_SESSION_IMPORT_MAX_SELECTION)
              .map(({ candidateId }) => candidateId),
          },
        });
        if (!isActive()) return;
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) break;
          const failure = squashAtomCommandFailure(result);
          throw failure instanceof Error
            ? failure
            : new Error("The conversations could not be imported.");
        }
        collected.push(...result.value.items);
        setResults([...collected]);
        const copied = new Set(
          result.value.items
            .filter(({ status }) => status !== "failed")
            .map(({ candidateId }) => candidateId),
        );
        setSelected((current) => new Map([...current].filter(([id]) => !copied.has(id))));
      }
      if (isActive()) inspection.refresh();
    } catch (cause) {
      if (isActive())
        setError(
          cause instanceof Error
            ? cause.message
            : "The import could not be completed. You can retry.",
        );
    } finally {
      if (isActive()) {
        importingRef.current = false;
        setProgress(null);
      }
    }
  };

  return (
    <SettingsSection title="Import sessions">
      <SettingsRow
        title="Bring conversations into a project"
        description="Browse Codex and Claude Code conversations, preview their content, and choose where they belong."
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
            data-workjet-action="session-import.open"
          >
            <FolderInputIcon className="size-3.5" />
            Browse conversations
            <ArrowRightIcon className="size-3.5" />
          </Button>
        }
      />
      <SessionImportBrowser
        open={open}
        onOpenChange={setOpen}
        inspection={inspection.data}
        pending={inspection.isPending}
        error={error ?? inspection.error ?? null}
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setPreview(null);
        }}
        source={source}
        onSourceChange={(value) => {
          setSource(value);
          setPage(0);
          setPreview(null);
        }}
        page={page}
        onPageChange={(value) => {
          setPage(value);
          setPreview(null);
        }}
        onRefresh={inspection.refresh}
        selected={selected}
        onSelect={(candidate, checked) =>
          setSelected((current) => {
            const next = new Map(current);
            if (checked) next.set(candidate.candidateId, candidate);
            else next.delete(candidate.candidateId);
            return next;
          })
        }
        onClearSelection={() => setSelected(new Map())}
        onSelectAll={() => void selectAllMatches()}
        preview={preview}
        onPreview={setPreview}
        projects={projects}
        destination={destination}
        onDestinationChange={(value) => {
          setDestination(value);
          setError(null);
          setWorkspaceRoot("");
          if (value === "new") {
            const folders = [
              ...new Set([...selected.values()].map((candidate) => candidate.workspaceRoot)),
            ];
            if (folders.length === 1 && folders[0]) {
              setWorkspaceRoot(folders[0]);
              setNewProjectTitle(sessionImportFolderName(folders[0]));
            }
          }
        }}
        newProjectTitle={newProjectTitle}
        onNewProjectTitleChange={setNewProjectTitle}
        workspaceRoot={workspaceRoot}
        onWorkspaceRootChange={setWorkspaceRoot}
        {...(isElectron && environmentId === primaryEnvironmentId
          ? {
              onPickFolder: () => {
                void ensureLocalApi()
                  .dialogs.pickFolder()
                  .then((folder) => {
                    if (folder && isActive()) setWorkspaceRoot(folder);
                  })
                  .catch(() => {
                    if (isActive())
                      setError("Enter the folder path if the folder picker is unavailable.");
                  });
              },
            }
          : {})}
        canImport={canImport}
        readOnly={readOnly}
        progress={progress}
        results={results}
        onStop={() => {
          stoppedRef.current = true;
        }}
        onImport={() => void importSelected()}
        onOpenThread={(item) => {
          if (!item.threadId || !isActive()) return;
          setOpen(false);
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: item.threadId },
          });
        }}
      />
    </SettingsSection>
  );
}
