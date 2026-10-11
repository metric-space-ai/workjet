import { useAtomValue } from "@effect/atom-react";
import { type ScopedThreadRef } from "@workjet/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@workjet/client-runtime/state/runtime";
import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
  SourceControlRepositoryVisibility,
  VcsStatusResult,
} from "@workjet/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
  LockIcon,
  GlobeIcon,
} from "lucide-react";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "~/components/Icons";
import { cn } from "~/lib/utils";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  repositoryNameFromPath,
} from "./GitActionsControl.logic";
import { InlineConfirmBar } from "~/components/InlineNoticeSlot";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Group, GroupSeparator } from "~/components/ui/group";
import { InlinePanel } from "~/components/ui/inline-panel";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useSourceControlPublishRepositoryAction,
  useVcsInitAction,
  useVcsPullAction,
} from "~/lib/sourceControlActions";
import { useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { openPullRequestLink } from "~/lib/openPullRequestLink";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  /**
   * Opens the thread's own change request beside it. Absent when the thread has no project to
   * place it against, in which case it still opens in the browser.
   */
  onOpenPullRequest?: ((number: number) => void) | undefined;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type PublishProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

type RefreshVcsStatus = (target: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: ScopedThreadRef["environmentId"] | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}
const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

const PUBLISH_PROVIDER_OPTIONS = [
  {
    value: "github",
    label: "GitHub",
    description: "github.com",
    host: "github.com",
    pathPlaceholder: "owner/repo",
    Icon: GitHubIcon,
  },
  {
    value: "gitlab",
    label: "GitLab",
    description: "gitlab.com",
    host: "gitlab.com",
    pathPlaceholder: "group/project",
    Icon: GitLabIcon,
  },
  {
    value: "bitbucket",
    label: "Bitbucket",
    description: "bitbucket.org",
    host: "bitbucket.org",
    pathPlaceholder: "workspace/repository",
    Icon: BitbucketIcon,
  },
  {
    value: "azure-devops",
    label: "Azure DevOps",
    description: "dev.azure.com",
    host: "dev.azure.com",
    pathPlaceholder: "project/repository",
    Icon: AzureDevOpsIcon,
  },
] as const satisfies ReadonlyArray<{
  readonly value: PublishProviderKind;
  readonly label: string;
  readonly description: string;
  readonly host: string;
  readonly pathPlaceholder: string;
  readonly Icon: typeof GitHubIcon;
}>;

function publishProviderOption(provider: PublishProviderKind) {
  return (
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]
  );
}

function isPublishProviderKind(
  provider: SourceControlProviderKind,
): provider is PublishProviderKind {
  return PUBLISH_PROVIDER_OPTIONS.some((option) => option.value === provider);
}

function getPublishProviderReadiness(input: {
  provider: PublishProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
}): { readonly ready: boolean; readonly hint: string | null } {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: "Anbieterstatus unbekannt",
    };
  }
  if (discovered.status !== "available") {
    return { ready: false, hint: discovered.installHint };
  }
  if (discovered.auth.status === "unauthenticated") {
    return {
      ready: false,
      hint: Option.getOrNull(discovered.auth.detail) ?? `${discovered.label} nicht angemeldet`,
    };
  }
  return { ready: true, hint: null };
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Läuft seit ${elapsedSeconds} s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Läuft seit ${minutes} Min. ${seconds} s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git-Aktion läuft";
  if (!gitStatus) return "Git-Status nicht verfügbar";

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Keine Änderungen";
    }
    return "Übernehmen nicht möglich";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Kein Zweig ausgecheckt";
    }
    if (hasChanges) {
      return "Erst Änderungen übernehmen";
    }
    if (isBehind) {
      return "Veraltet, erst herunterladen";
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return "Kein Remote „origin“";
    }
    if (!isAhead) {
      return "Nichts zum Hochladen";
    }
    return "Hochladen nicht möglich";
  }

  if (hasOpenPr) {
    return `${terminology.shortLabel} nicht verfügbar`;
  }
  if (!hasBranch) {
    return "Kein Zweig ausgecheckt";
  }
  if (hasChanges) {
    return "Erst Änderungen übernehmen";
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return "Kein Remote „origin“";
  }
  if (!isAhead) {
    return "Keine neuen Änderungen";
  }
  if (isBehind) {
    return "Veraltet, erst herunterladen";
  }
  return `${terminology.shortLabel} nicht möglich`;
}

/** Die Frage der Inline-Bestätigung für den Standard-Branch, eine Zeile. */
function defaultBranchConfirmTitle(pending: PendingDefaultBranchAction): string {
  const branch = pending.branchName;
  if (pending.action === "push" || pending.action === "commit_push") {
    return pending.includesCommit
      ? `Übernehmen und auf ${branch} hochladen?`
      : `Auf ${branch} hochladen?`;
  }
  return pending.includesCommit
    ? `Von ${branch} übernehmen, hochladen und PR erstellen?`
    : `Von ${branch} hochladen und PR erstellen?`;
}

function GitActionItemIcon({
  icon,
  SourceControlIcon,
}: {
  icon: GitActionIconName;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <SourceControlIcon />;
}

function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
}: {
  quickAction: GitQuickAction;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <SourceControlIcon className={iconClassName} />;
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <SourceControlIcon className={iconClassName} />;
  }
  if (quickAction.label === "Übernehmen") return <GitCommitIcon className={iconClassName} />;
  if (quickAction.label === "Hochladen") return <CloudUploadIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

interface PublishRepositoryPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: ScopedThreadRef["environmentId"] | null;
  readonly gitCwd: string;
}

/**
 * Repository veröffentlichen, inline im Git-Bereich (drei Orte, keine Popups):
 * Anbieter als Auswahl, Name, Sichtbarkeit als Schalter, „Veröffentlichen“.
 * Keine Schritte, keine Karten, kein „Erweitert“: Remote ist immer „origin“
 * über SSH. Erfolg meldet ein einzeiliger Toast mit „Öffnen“.
 */
function PublishRepositoryPanel(props: PublishRepositoryPanelProps) {
  const sourceControlDiscovery = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: props.environmentId,
          input: {},
        }),
  );
  const [selectedPublishProvider, setSelectedPublishProvider] =
    useState<PublishProviderKind | null>(null);
  const [publishRepositoryOverride, setPublishRepositoryOverride] = useState<string | null>(null);
  const [publishVisibility, setPublishVisibility] =
    useState<SourceControlRepositoryVisibility>("private");
  const [publishError, setPublishError] = useState<string | null>(null);
  const sourceControlScope = useMemo(
    () => ({
      environmentId: props.environmentId,
      cwd: props.gitCwd,
    }),
    [props.environmentId, props.gitCwd],
  );
  const publishRepositoryAction = useSourceControlPublishRepositoryAction(sourceControlScope);
  const publishAccountByProvider = useMemo(() => {
    const accounts: Record<PublishProviderKind, string | null> = {
      github: null,
      gitlab: null,
      bitbucket: null,
      "azure-devops": null,
    };
    for (const provider of sourceControlDiscovery.data?.sourceControlProviders ?? []) {
      if (isPublishProviderKind(provider.kind)) {
        accounts[provider.kind] = Option.getOrNull(provider.auth.account);
      }
    }
    return accounts;
  }, [sourceControlDiscovery.data]);
  const publishProviderReadiness = useMemo(() => {
    const sourceControlProviders = sourceControlDiscovery.data?.sourceControlProviders ?? [];
    return Object.fromEntries(
      PUBLISH_PROVIDER_OPTIONS.map((option) => [
        option.value,
        getPublishProviderReadiness({
          provider: option.value,
          sourceControlProviders,
        }),
      ]),
    ) as Record<PublishProviderKind, { readonly ready: boolean; readonly hint: string | null }>;
  }, [sourceControlDiscovery.data]);
  const sortedPublishProviderOptions = useMemo(
    () =>
      PUBLISH_PROVIDER_OPTIONS.toSorted((left, right) => {
        const leftReady = publishProviderReadiness[left.value].ready;
        const rightReady = publishProviderReadiness[right.value].ready;
        if (leftReady !== rightReady) {
          return leftReady ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      }),
    [publishProviderReadiness],
  );
  const firstReadyPublishProvider = sortedPublishProviderOptions.find(
    (option) => publishProviderReadiness[option.value].ready,
  )?.value;
  // Erkennen statt fragen: der erste angemeldete Anbieter ist vorausgewählt.
  const publishProvider =
    selectedPublishProvider !== null && publishProviderReadiness[selectedPublishProvider].ready
      ? selectedPublishProvider
      : (firstReadyPublishProvider ?? selectedPublishProvider ?? "github");
  const selectedPublishProviderReadiness = publishProviderReadiness[publishProvider];
  // Erkennen statt fragen: Konto und Ordnername sind vorbefüllt.
  const publishRepositoryPrefill = publishAccountByProvider[publishProvider]
    ? `${publishAccountByProvider[publishProvider]}/${repositoryNameFromPath(props.gitCwd)}`
    : "";
  const publishRepository = publishRepositoryOverride ?? publishRepositoryPrefill;
  const currentPublishProvider = publishProviderOption(publishProvider);

  const canSubmitPublishRepository = useMemo(() => {
    if (!selectedPublishProviderReadiness.ready) return false;
    if (publishRepositoryAction.isPending) return false;
    const repositoryParts = publishRepository.trim().split("/");
    const owner = repositoryParts[0]?.trim() ?? "";
    const name = repositoryParts.slice(1).join("/").trim();
    return owner.length > 0 && name.length > 0;
  }, [publishRepository, publishRepositoryAction.isPending, selectedPublishProviderReadiness]);

  const resetState = useCallback(() => {
    setPublishRepositoryOverride(null);
    setPublishError(null);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      props.onOpenChange(open);
      if (!open) {
        resetState();
      }
    },
    [props, resetState],
  );

  const submitPublishRepository = useCallback(() => {
    if (!canSubmitPublishRepository) {
      return;
    }
    setPublishError(null);
    void (async () => {
      const result = await publishRepositoryAction.run({
        provider: publishProvider,
        repository: publishRepository.trim(),
        visibility: publishVisibility,
        remoteName: "origin",
        protocol: "ssh",
      });

      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setPublishError(
            error instanceof Error ? error.message : "Veröffentlichen fehlgeschlagen",
          );
        }
        return;
      }

      const published = result.value;
      handleOpenChange(false);
      toastManager.add({
        type: "success",
        title:
          published.status === "pushed"
            ? `${published.repository.nameWithOwner} veröffentlicht`
            : `${published.repository.nameWithOwner} angelegt`,
        actionProps: {
          children: "Öffnen",
          onClick: () => {
            const api = readLocalApi();
            if (!api) return;
            void api.shell.openExternal(published.repository.url);
          },
        },
      });
    })();
  }, [
    canSubmitPublishRepository,
    handleOpenChange,
    publishProvider,
    publishRepository,
    publishRepositoryAction,
    publishVisibility,
  ]);

  const status = publishRepositoryAction.isPending
    ? `Veröffentlicht bei ${currentPublishProvider.label} …`
    : publishError
      ? publishError
      : !selectedPublishProviderReadiness.ready
        ? `${currentPublishProvider.label} nicht angemeldet`
        : null;

  return (
    <InlinePanel
      triggerLabel="Veröffentlichen"
      open={props.open}
      onOpenChange={handleOpenChange}
      submitLabel="Veröffentlichen"
      onSubmit={submitPublishRepository}
      submitDisabled={!canSubmitPublishRepository}
      busy={publishRepositoryAction.isPending}
      status={status}
      statusTone={publishError || !selectedPublishProviderReadiness.ready ? "error" : "neutral"}
      className="w-full"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="publish-provider">Anbieter</Label>
          <Select
            value={publishProvider}
            onValueChange={(value) => {
              setSelectedPublishProvider(value as PublishProviderKind);
              setPublishRepositoryOverride(null);
            }}
          >
            <SelectTrigger id="publish-provider" size="sm">
              <SelectValue>
                <span className="flex items-center gap-2">
                  <currentPublishProvider.Icon className="size-3.5" aria-hidden />
                  {currentPublishProvider.label}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {sortedPublishProviderOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={!publishProviderReadiness[option.value].ready}
                >
                  <span className="flex items-center gap-2">
                    <option.Icon className="size-3.5" aria-hidden />
                    {option.label}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="publish-repository-path">Name</Label>
          <Input
            id="publish-repository-path"
            name="publish-repository-path"
            size="sm"
            className="font-mono"
            value={publishRepository}
            onChange={(event) => setPublishRepositoryOverride(event.target.value)}
            placeholder={currentPublishProvider.pathPlaceholder}
            disabled={publishRepositoryAction.isPending}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[13.5px]" htmlFor="publish-visibility">
        <Switch
          id="publish-visibility"
          checked={publishVisibility === "public"}
          disabled={publishRepositoryAction.isPending}
          onCheckedChange={(checked) => setPublishVisibility(checked ? "public" : "private")}
        />
        {publishVisibility === "public" ? (
          <span className="flex items-center gap-1.5">
            <GlobeIcon className="size-3.5 text-muted-foreground" aria-hidden />
            Öffentlich
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <LockIcon className="size-3.5 text-muted-foreground" aria-hidden />
            Privat
          </span>
        )}
      </label>
    </InlinePanel>
  );
}

export default function GitActionsControl({
  gitCwd,
  activeThreadRef,
  draftId,
  onOpenPullRequest,
}: GitActionsControlProps) {
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread branch metadata update",
  );
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const activeServerThread = useThread(activeThreadRef, {
    waitForShell: activeDraftThread !== null,
  });
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [commitOnNewBranch, setCommitOnNewBranch] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  const sourceControlScope = useMemo(
    () => ({ environmentId: activeEnvironmentId, cwd: gitCwd }),
    [activeEnvironmentId, gitCwd],
  );
  let runGitActionWithToast: (input: RunGitActionWithToastInput) => Promise<void>;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        void updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
          },
        });

        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      draftId,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  const gitStatusQuery = useEnvironmentQuery(
    activeEnvironmentId !== null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: activeEnvironmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const { data: gitStatus, error: gitStatusError } = gitStatusQuery;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = gitStatus;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initAction = useVcsInitAction(sourceControlScope);
  const runImmediateGitAction = useGitStackedAction(sourceControlScope);
  const pullAction = useVcsPullAction(sourceControlScope);
  const isGitActionRunning = useSourceControlActionRunning(
    sourceControlScope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread,
    activeDraftThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    isSelectingWorktreeBase,
    persistThreadBranchSync,
  ]);

  const isDefaultRef = useMemo(() => {
    return gitStatusForActions?.isDefaultRef ?? false;
  }, [gitStatusForActions?.isDefaultRef]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isGitActionRunning],
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "Nicht verfügbar")
    : null;

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  useEffect(() => {
    if (gitCwd === null) {
      return;
    }

    let refreshTimeout: number | null = null;
    const scheduleRefreshCurrentGitStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshCurrentGitStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshCurrentGitStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshCurrentGitStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEnvironmentId, gitCwd, refreshVcsStatus]);

  const openExistingPr = useCallback(async () => {
    const openPr = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr : null;
    // Beside the thread where it was made, the way the browser opens beside it. Checked before
    // the shell, which opening in the app does not need.
    if (openPr && onOpenPullRequest) {
      onOpenPullRequest(openPr.number);
      return;
    }
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link öffnen nicht verfügbar",
        data: threadToastData,
      });
      return;
    }
    const prUrl = openPr?.url ?? null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "Kein offener Pull Request",
        data: threadToastData,
      });
      return;
    }
    void openPullRequestLink(api.shell, prUrl).catch((err: unknown) => {
      console.error(err);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Pull Request nicht geöffnet",
          description: err instanceof Error ? err.message : undefined,
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    });
  }, [gitStatusForActions, onOpenPullRequest, threadToastData]);

  runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
    }: RunGitActionWithToastInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.refName ?? null;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      const includesCommit =
        actionCanCommit &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Git-Aktion läuft …",
          description: "Wartet auf Git …",
          timeout: 0,
          data: scopedToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? "Git-Aktion läuft …",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Git-Aktion läuft …",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Git-Aktion läuft …",
          description: "Wartet auf Git …",
          timeout: 0,
          data: scopedToastData,
        });
      }

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `${event.hookName} läuft …`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Wird übernommen …";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Let the settled mutation publish the error toast to avoid a
            // transient intermediate state before the final failure message.
            return;
        }

        updateActiveProgressToast();
      };

      const result = await runImmediateGitAction.run({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: applyProgressEvent,
      });

      activeGitActionProgressRef.current = null;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(resolvedProgressToastId);
          return;
        }

        const error = squashAtomCommandFailure(result);
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "error",
            title: "Git-Aktion fehlgeschlagen",
            description: error instanceof Error ? error.message : undefined,
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
        return;
      }

      const actionResult = result.value;
      syncThreadBranchAfterGitAction(actionResult);
      const closeResultToast = () => {
        toastManager.close(resolvedProgressToastId);
      };

      const toastCta = actionResult.toast.cta;
      let toastActionProps: {
        children: string;
        onClick: () => void;
      } | null = null;
      if (toastCta.kind === "run_action") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            closeResultToast();
            void runGitActionWithToast({
              action: toastCta.action.kind,
            });
          },
        };
      } else if (toastCta.kind === "open_pr") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            const api = readLocalApi();
            if (!api) return;
            closeResultToast();
            void api.shell.openExternal(toastCta.url);
          },
        };
      }

      const successToastData = {
        ...scopedToastData,
        dismissAfterVisibleMs: 10_000,
      };

      if (toastActionProps) {
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "success",
            title: actionResult.toast.title,
            description: actionResult.toast.description,
            timeout: 0,
            actionProps: toastActionProps,
            data: successToastData,
          }),
        );
      } else {
        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: actionResult.toast.title,
          description: actionResult.toast.description,
          timeout: 0,
          data: successToastData,
        });
      }
    },
  );

  const continuePendingDefaultBranchAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  };

  const checkoutFeatureBranchAndContinuePendingAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const closeCommitPanel = () => {
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setCommitOnNewBranch(false);
  };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setCommitOnNewBranch(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "open_publish") {
      setIsPublishDialogOpen(true);
      return;
    }
    if (quickAction.kind === "run_pull") {
      const toastId = toastManager.add({
        type: "loading",
        title: "Wird heruntergeladen …",
        timeout: 0,
        data: threadToastData,
      });
      void (async () => {
        const result = await pullAction.run();
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            toastManager.close(toastId);
            return;
          }
          const error = squashAtomCommandFailure(result);
          toastManager.update(
            toastId,
            stackedThreadToast({
              type: "error",
              title: "Herunterladen fehlgeschlagen",
              description: error instanceof Error ? error.message : undefined,
              ...(threadToastData !== undefined ? { data: threadToastData } : {}),
            }),
          );
          return;
        }

        const pullResult = result.value;
        toastManager.update(toastId, {
          type: "success",
          title: pullResult.status === "pulled" ? "Heruntergeladen" : "Bereits aktuell",
          data: threadToastData,
        });
      })();
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    setExcludedFiles(new Set());
    setCommitOnNewBranch(false);
    setIsCommitDialogOpen(true);
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setCommitOnNewBranch(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  };

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor nicht verfügbar",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void (async () => {
        const result = await openInPreferredEditor(target);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Datei nicht geöffnet",
            description: error instanceof Error ? error.message : undefined,
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })();
    },
    [gitCwd, openInPreferredEditor, threadToastData],
  );

  const canPublishRepository = isRepo && gitStatusForActions !== null && !hasPrimaryRemote;

  if (!gitCwd) return null;

  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-2" data-slot="git-actions">
      {!isRepo ? (
        <Button
          variant="outline"
          size="xs"
          disabled={initAction.isPending}
          onClick={() => {
            void (async () => {
              const result = await initAction.run();
              if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
                return;
              }
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Git nicht initialisiert",
                  description: error instanceof Error ? error.message : undefined,
                  ...(threadToastData !== undefined ? { data: threadToastData } : {}),
                }),
              );
            })();
          }}
        >
          <GitBranchPlusIcon className="size-3.5" aria-hidden />
          <span className="ml-0.5">
            {initAction.isPending ? "Initialisiert …" : "Git initialisieren"}
          </span>
        </Button>
      ) : (
        <Group aria-label="Git-Aktionen" className="shrink-0">
          {quickActionDisabledReason ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-disabled="true"
                    className="cursor-not-allowed rounded-e-none border-e-0 ps-[8.5px] opacity-64 before:rounded-e-none"
                    size="xs"
                    variant="outline"
                  />
                }
              >
                <GitQuickActionIcon
                  quickAction={quickAction}
                  SourceControlIcon={SourceControlIcon}
                />
                <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                  {quickAction.label}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom" align="start">
                {quickActionDisabledReason}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <Button
              variant="outline"
              size="xs"
              className="ps-[8.5px]"
              disabled={isGitActionRunning || quickAction.disabled}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon quickAction={quickAction} SourceControlIcon={SourceControlIcon} />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                {quickAction.label}
              </span>
            </Button>
          )}
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu
            onOpenChange={(open) => {
              if (open) {
                requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
              }
            }}
          >
            <MenuTrigger
              render={<Button aria-label="Weitere Git-Aktionen" size="icon-xs" variant="outline" />}
              disabled={isGitActionRunning}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-full">
              {gitActionMenuItems.map((item) => {
                const disabledReason = getMenuActionDisabledReason({
                  item,
                  gitStatus: gitStatusForActions,
                  isBusy: isGitActionRunning,
                  hasPrimaryRemote,
                });
                if (item.disabled && disabledReason) {
                  // Der Grund steht im nativen Tooltip; der Eintrag bleibt ein einfacher Eintrag.
                  return (
                    <MenuItem key={`${item.id}-${item.label}`} disabled title={disabledReason}>
                      <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
                      {item.label}
                    </MenuItem>
                  );
                }

                return (
                  <MenuItem
                    key={`${item.id}-${item.label}`}
                    disabled={item.disabled}
                    onClick={() => {
                      openDialogForMenuItem(item);
                    }}
                  >
                    <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
                    {item.label}
                  </MenuItem>
                );
              })}
              {canPublishRepository ? (
                <MenuItem
                  disabled={isGitActionRunning}
                  onClick={() => {
                    setIsPublishDialogOpen(true);
                  }}
                >
                  <CloudUploadIcon />
                  Veröffentlichen
                </MenuItem>
              ) : null}
              {gitStatusForActions?.refName === null ? (
                <MenuItem disabled>Kein Zweig ausgecheckt</MenuItem>
              ) : null}
              {gitStatusForActions &&
              gitStatusForActions.refName !== null &&
              !gitStatusForActions.hasWorkingTreeChanges &&
              gitStatusForActions.behindCount > 0 &&
              gitStatusForActions.aheadCount === 0 ? (
                <MenuItem disabled>Veraltet, erst herunterladen</MenuItem>
              ) : null}
              {gitStatusError ? (
                <MenuItem disabled title={gitStatusError}>
                  Git-Status nicht verfügbar
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </Group>
      )}

      {/* Commit inline im Git-Bereich: Dateien als Haken, eine Nachricht, ein Schalter
          für einen neuen Branch. Kein Dialog (drei Orte, keine Popups). */}
      {isCommitDialogOpen ? (
        <InlinePanel
          triggerLabel="Übernehmen"
          open
          onOpenChange={(open) => {
            if (!open) closeCommitPanel();
          }}
          submitLabel={commitOnNewBranch ? "Auf neuem Zweig übernehmen" : "Übernehmen"}
          submitDisabled={noneSelected}
          onSubmit={commitOnNewBranch ? runDialogActionOnNewBranch : runDialogAction}
          status={
            isDefaultRef && !commitOnNewBranch
              ? `${gitStatusForActions?.refName ?? "Standardzweig"} ist der Standardzweig`
              : null
          }
          className="w-full"
        >
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">
              {gitStatusForActions?.refName ?? "—"}
            </span>
            <span className="shrink-0 font-mono">
              <span className="text-success">
                +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
              </span>{" "}
              <span className="text-destructive">
                -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
              </span>
            </span>
          </div>
          {allFiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">Keine Änderungen</p>
          ) : (
            <ScrollArea className="max-h-44 rounded-md border">
              <div className="flex flex-col p-1">
                <label className="flex items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={!allSelected && !noneSelected}
                    onCheckedChange={() => {
                      setExcludedFiles(
                        allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                      );
                    }}
                  />
                  Alle Dateien ({selectedFiles.length}/{allFiles.length})
                </label>
                {allFiles.map((file) => {
                  const isExcluded = excludedFiles.has(file.path);
                  return (
                    <div
                      key={file.path}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 font-mono text-xs hover:bg-accent/50"
                    >
                      <Checkbox
                        aria-label={file.path}
                        checked={!isExcluded}
                        onCheckedChange={() => {
                          setExcludedFiles((prev) => {
                            const next = new Set(prev);
                            if (next.has(file.path)) {
                              next.delete(file.path);
                            } else {
                              next.add(file.path);
                            }
                            return next;
                          });
                        }}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                        onClick={() => openChangedFileInEditor(file.path)}
                      >
                        <span className={cn("truncate", isExcluded && "text-muted-foreground")}>
                          {file.path}
                        </span>
                        {isExcluded ? null : (
                          <span className="shrink-0">
                            <span className="text-success">+{file.insertions}</span>{" "}
                            <span className="text-destructive">-{file.deletions}</span>
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
          <Textarea
            aria-label="Nachricht"
            value={dialogCommitMessage}
            onChange={(event) => setDialogCommitMessage(event.target.value)}
            placeholder="Nachricht"
            size="sm"
          />
          <label className="flex items-center gap-2 text-[13.5px]">
            <Switch
              checked={commitOnNewBranch}
              onCheckedChange={(checked) => setCommitOnNewBranch(checked === true)}
            />
            Neuer Zweig
          </label>
        </InlinePanel>
      ) : null}

      {/* Ohne Remote steht „Veröffentlichen“ direkt im Git-Bereich. */}
      {canPublishRepository || isPublishDialogOpen ? (
        <PublishRepositoryPanel
          open={isPublishDialogOpen}
          onOpenChange={setIsPublishDialogOpen}
          environmentId={activeEnvironmentId}
          gitCwd={gitCwd}
        />
      ) : null}

      {/* Bestätigung für den Standardzweig inline, nie als Dialog. */}
      {pendingDefaultBranchAction !== null ? (
        <InlineConfirmBar
          className="rounded-lg border"
          confirmLabel={`Auf ${pendingDefaultBranchAction.branchName}`}
          markers={{ row: "git-default-branch-confirm" }}
          question={defaultBranchConfirmTitle(pendingDefaultBranchAction)}
          secondary={{
            label: "Neuer Zweig",
            onClick: checkoutFeatureBranchAndContinuePendingAction,
          }}
          onCancel={() => setPendingDefaultBranchAction(null)}
          onConfirm={continuePendingDefaultBranchAction}
        />
      ) : null}
    </div>
  );
}
