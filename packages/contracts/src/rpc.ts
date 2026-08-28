import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
  OrchestrationGetWorkflowScriptError,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestInvalidateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import { UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import {
  GreppyRuntimeSnapshot,
  WorkjetHarnessAvailabilitySnapshot,
  WorkjetGatewayAddApiKeyAccountInput,
  WorkjetGatewayAddApiKeyAccountResult,
  WorkjetGatewayRemoveAccountInput,
  WorkjetGatewayRemoveAccountResult,
  WorkjetGatewayCatalog,
  WorkjetGatewayHealth,
  WorkjetGatewayModelDiscovery,
  WorkjetGatewayOauthPollInput,
  WorkjetGatewayOauthPollResult,
  WorkjetGatewayOauthSession,
  WorkjetGatewayOauthStartInput,
  WorkjetGatewayOperationError,
  WorkjetGatewayStatus,
  WorkjetGatewayUpdateRoutingInput,
  WorkjetGatewayUpdateRoutingResult,
  WorkjetGreppyOperationError,
  WorktreeStorageInspection,
  WorktreeStorageInspectionInput,
} from "./workjet.ts";
import {
  WorkjetLegacyImportDecideInput,
  WorkjetLegacyImportDecisionResult,
  WorkjetLegacyImportError,
  WorkjetLegacyImportInspectInput,
  WorkjetLegacyImportInspection,
} from "./workjetLegacyImport.ts";
import {
  WorkjetSessionImportError,
  WorkjetSessionImportInput,
  WorkjetSessionImportInspectInput,
  WorkjetSessionImportInspection,
  WorkjetSessionImportResult,
} from "./workjetSessionImport.ts";
import {
  WorkjetMailboxAcceptHandoffRpcInput,
  WorkjetMailboxAcceptHandoffRpcResult,
  WorkjetMailboxDelegateTaskRpcInput,
  WorkjetMailboxDelegateTaskRpcResult,
  WorkjetMailboxError,
  WorkjetMailboxListHandoffsRpcInput,
  WorkjetMailboxListHandoffsRpcResult,
  WorkjetMailboxReplyRpcInput,
  WorkjetMailboxReplyRpcResult,
  WorkjetMailboxReassignDelegationRpcInput,
  WorkjetMailboxReassignDelegationRpcResult,
  WorkjetMailboxRequestReviewRpcInput,
  WorkjetMailboxRequestReviewRpcResult,
  WorkjetMailboxSendHandoffRpcInput,
  WorkjetMailboxSendHandoffRpcResult,
  WorkjetMailboxSendMessageRpcInput,
  WorkjetMailboxSendMessageRpcResult,
  WorkjetMailboxUpdateDelegationRpcInput,
  WorkjetMailboxUpdateDelegationRpcResult,
  WorkjetMeshOverview,
  WorkjetMeshRevokePeerInput,
  WorkjetMeshRevokePeerResult,
  WorkjetMeshRoster,
} from "./workjetMailbox.ts";
import { WorkjetMailboxAuditEvent } from "./workjetMailboxAudit.ts";
import {
  WorkjetCrossModeError,
  WorkjetCrossModeGetThreadLinkRpcInput,
  WorkjetCrossModeGetThreadLinkRpcResult,
  WorkjetCrossModeListLinksRpcInput,
  WorkjetCrossModeListLinksRpcResult,
  WorkjetCrossModeOpenInCodeRpcInput,
  WorkjetCrossModeOpenInCodeRpcResult,
  WorkjetCrossModeSubmitRpcInput,
  WorkjetCrossModeSubmitRpcResult,
} from "./workjetCrossMode.ts";
import {
  WorkjetDecisionHubConnectionError,
  WorkjetDecisionHubConnectionResult,
  WorkjetDecisionHubDisconnectInput,
  WorkjetDecisionHubDisconnectResult,
  WorkjetDecisionHubListResult,
  WorkjetDecisionHubProbeInput,
  WorkjetDecisionHubProvisionInput,
} from "./workjetDecisionHub.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  serverGetUsageSummary: "server.getUsageSummary",

  // Workjet server-wide capability management
  workjetGreppyInspect: "workjet.greppy.inspect",
  workjetGreppyInstall: "workjet.greppy.install",
  workjetWorktreesInspect: "workjet.worktrees.inspect",
  // Live harness availability, replacing the hand-toggled `available` flag on
  // WorkjetHarnessConfiguration.
  //
  // INSPECT ONLY, deliberately. The plan also asks for install/update/remove,
  // but there is no harness installer anywhere in the app: Greppy has one
  // because it is a MANAGED, pinned binary this app downloads, while
  // claude-code, codex-cli and the rest are third-party CLIs the operator
  // installs themselves. Declaring three RPCs with nothing to call would ship
  // a surface that always fails; building them means deciding that the app may
  // run third-party installers on the operator's host, which is a security
  // decision and not a missing handler.
  workjetHarnessInspect: "workjet.harness.inspect",

  // Environment-scoped Workjet provider gateway authority
  workjetGatewayStatus: "workjet.providerGateway.status",
  workjetGatewayCatalog: "workjet.providerGateway.catalog",
  workjetGatewayStart: "workjet.providerGateway.start",
  workjetGatewayStop: "workjet.providerGateway.stop",
  workjetGatewayOauthStart: "workjet.providerGateway.oauthStart",
  workjetGatewayOauthPoll: "workjet.providerGateway.oauthPoll",
  workjetGatewayOauthCancel: "workjet.providerGateway.oauthCancel",
  workjetGatewayAddApiKeyAccount: "workjet.providerGateway.addApiKeyAccount",
  workjetGatewayRemoveAccount: "workjet.providerGateway.removeAccount",
  workjetGatewayHealth: "workjet.providerGateway.health",
  workjetGatewayDiscoverModels: "workjet.providerGateway.discoverModels",
  workjetGatewayUpdateRouting: "workjet.providerGateway.updateRouting",

  // ADDITIVE one-shot import of the legacy Swift Workjet configuration. The
  // decision is per ENVIRONMENT — the legacy document lives on the machine the
  // server runs on and lands in that server's own `settings.workjet` — so both
  // methods answer for this server and take no environment in their payload.
  workjetLegacyImportInspect: "workjet.legacyImport.inspect",
  workjetLegacyImportDecide: "workjet.legacyImport.decide",

  // Repeatable static copies of third-party harness transcripts. Importing
  // never resumes or mutates the source provider session.
  workjetSessionImportInspect: "workjet.sessionImport.inspect",
  workjetSessionImport: "workjet.sessionImport.import",

  // Thread-scoped Workjet mailbox sends (orchestrator threads only)
  workjetMailboxSendMessage: "workjet.mailbox.sendMessage",
  workjetMailboxDelegateTask: "workjet.mailbox.delegateTask",
  workjetMailboxReply: "workjet.mailbox.reply",
  workjetMailboxRequestReview: "workjet.mailbox.requestReview",
  workjetMailboxUpdateDelegation: "workjet.mailbox.updateDelegation",
  // ADDITIVE Wave-5 write: move a pending delegation to another LOCAL thread.
  workjetMailboxReassignDelegation: "workjet.mailbox.reassignDelegation",

  // ADDITIVE thread-handoff slice: hand a thread's bounded context snapshot to
  // another machine, list what arrived here, and continue one in a NEW thread.
  workjetMailboxSendHandoff: "workjet.mailbox.sendHandoff",
  workjetMailboxListHandoffs: "workjet.mailbox.listHandoffs",
  workjetMailboxAcceptHandoff: "workjet.mailbox.acceptHandoff",

  // ADDITIVE cross-mode workflow bridge: link a Business OS object to a Code
  // thread, read the backlink either way, and return results/reviews/follow-ups
  // to the Business OS authority through the validated CTOX MCP command path.
  workjetCrossModeOpenInCode: "workjet.crossMode.openInCode",
  workjetCrossModeGetThreadLink: "workjet.crossMode.getThreadLink",
  workjetCrossModeListLinks: "workjet.crossMode.listLinks",
  workjetCrossModeSubmit: "workjet.crossMode.submit",

  // Environment-scoped Decision Hub connection registry. Provisioning is a
  // write-only desktop-main path: responses contain redacted summaries only.
  workjetDecisionHubListConnections: "workjet.decisionHub.listConnections",
  workjetDecisionHubProvisionConnection: "workjet.decisionHub.provisionConnection",
  workjetDecisionHubProbeConnection: "workjet.decisionHub.probeConnection",
  workjetDecisionHubDisconnectConnection: "workjet.decisionHub.disconnectConnection",

  // ADDITIVE Wave-5 read: the recipient roster the composer picks from.
  workjetMeshRoster: "workjet.mesh.roster",
  // ADDITIVE read: the global multi-computer activity overview. Same redacted
  // projection as the roster, plus last-known contact and delegation counts.
  workjetMeshOverview: "workjet.mesh.overview",
  // ADDITIVE operate action: destroy one peer's trust-on-first-use pin so a
  // legitimately rotated peer can be re-pinned. The only recovery path out of a
  // refused key rotation, and the only mesh-trust WRITE this server exposes.
  workjetMeshRevokePeer: "workjet.mesh.revokePeer",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
  subscribeWorkjetMailboxAudit: "subscribeWorkjetMailboxAudit",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerWithProgressRpc = Rpc.make(
  WS_METHODS.serverUpdateServerWithProgress,
  {
    payload: ServerSelfUpdateInput,
    success: ServerSelfUpdateProgressEvent,
    error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

export const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

const WorkjetGreppyRpcError = Schema.Union([
  WorkjetGreppyOperationError,
  EnvironmentAuthorizationError,
]);

export const WsWorkjetGreppyInspectRpc = Rpc.make(WS_METHODS.workjetGreppyInspect, {
  payload: Schema.Struct({}),
  success: GreppyRuntimeSnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsWorkjetGreppyInstallRpc = Rpc.make(WS_METHODS.workjetGreppyInstall, {
  payload: Schema.Struct({}),
  success: GreppyRuntimeSnapshot,
  error: WorkjetGreppyRpcError,
});

export const WsWorkjetHarnessInspectRpc = Rpc.make(WS_METHODS.workjetHarnessInspect, {
  payload: Schema.Struct({}),
  success: WorkjetHarnessAvailabilitySnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsWorkjetWorktreesInspectRpc = Rpc.make(WS_METHODS.workjetWorktreesInspect, {
  payload: WorktreeStorageInspectionInput,
  success: WorktreeStorageInspection,
  error: EnvironmentAuthorizationError,
});

const WorkjetGatewayRpcError = Schema.Union([
  WorkjetGatewayOperationError,
  EnvironmentAuthorizationError,
]);

export const WsWorkjetGatewayStatusRpc = Rpc.make(WS_METHODS.workjetGatewayStatus, {
  payload: Schema.Struct({}),
  success: WorkjetGatewayStatus,
  error: EnvironmentAuthorizationError,
});

export const WsWorkjetGatewayCatalogRpc = Rpc.make(WS_METHODS.workjetGatewayCatalog, {
  payload: Schema.Struct({}),
  success: WorkjetGatewayCatalog,
  error: WorkjetGatewayRpcError,
});

export const WsWorkjetGatewayStartRpc = Rpc.make(WS_METHODS.workjetGatewayStart, {
  payload: Schema.Struct({}),
  success: WorkjetGatewayStatus,
  error: WorkjetGatewayRpcError,
});

export const WsWorkjetGatewayStopRpc = Rpc.make(WS_METHODS.workjetGatewayStop, {
  payload: Schema.Struct({}),
  success: WorkjetGatewayStatus,
  error: WorkjetGatewayRpcError,
});

export const WsWorkjetGatewayOauthStartRpc = Rpc.make(WS_METHODS.workjetGatewayOauthStart, {
  payload: WorkjetGatewayOauthStartInput,
  success: WorkjetGatewayOauthSession,
  error: WorkjetGatewayRpcError,
});

export const WsWorkjetGatewayOauthPollRpc = Rpc.make(WS_METHODS.workjetGatewayOauthPoll, {
  payload: WorkjetGatewayOauthPollInput,
  success: WorkjetGatewayOauthPollResult,
  error: WorkjetGatewayRpcError,
});

export const WsWorkjetGatewayOauthCancelRpc = Rpc.make(WS_METHODS.workjetGatewayOauthCancel, {
  payload: WorkjetGatewayOauthPollInput,
  success: Schema.Struct({}),
  error: WorkjetGatewayRpcError,
});

/**
 * Adds an API-key gateway account. The payload carries the key exactly once,
 * over the same authenticated WebSocket every other gateway operation uses;
 * the success value is the account identity only. The key is never part of any
 * response, log line, or configuration file.
 */
export const WsWorkjetGatewayAddApiKeyAccountRpc = Rpc.make(
  WS_METHODS.workjetGatewayAddApiKeyAccount,
  {
    payload: WorkjetGatewayAddApiKeyAccountInput,
    success: WorkjetGatewayAddApiKeyAccountResult,
    error: WorkjetGatewayRpcError,
  },
);

/** Removes one gateway account. The server deletes the account's secrets. */
export const WsWorkjetGatewayRemoveAccountRpc = Rpc.make(WS_METHODS.workjetGatewayRemoveAccount, {
  payload: WorkjetGatewayRemoveAccountInput,
  success: WorkjetGatewayRemoveAccountResult,
  error: WorkjetGatewayRpcError,
});

/**
 * Health as the running gateway host reports it. Read-only, and deliberately
 * carries availability flags for the dimensions the host does not publish.
 */
export const WsWorkjetGatewayHealthRpc = Rpc.make(WS_METHODS.workjetGatewayHealth, {
  payload: Schema.Struct({}),
  success: WorkjetGatewayHealth,
  error: WorkjetGatewayRpcError,
});

/** Models the host's own catalog serves, merged with the configured account models. */
export const WsWorkjetGatewayDiscoverModelsRpc = Rpc.make(WS_METHODS.workjetGatewayDiscoverModels, {
  payload: Schema.Struct({}),
  success: WorkjetGatewayModelDiscovery,
  error: WorkjetGatewayRpcError,
});

/** Edits the host-wide selection strategy and per-account pool membership. */
export const WsWorkjetGatewayUpdateRoutingRpc = Rpc.make(WS_METHODS.workjetGatewayUpdateRouting, {
  payload: WorkjetGatewayUpdateRoutingInput,
  success: WorkjetGatewayUpdateRoutingResult,
  error: WorkjetGatewayRpcError,
});

/**
 * The one-shot legacy Swift Workjet configuration import.
 *
 * `inspect` is a pure READ: it resolves the decision, previews the offer with NO
 * bindings (the honest floor), and lists every pending record and every drop.
 * `decide` is the only write, and it is terminal: accept applies exactly one
 * settings patch and records a marker, decline records the refusal, and both are
 * refused a second time. A binding naming an environment, gateway account, or
 * legacy record the server cannot verify is refused with
 * {@link WorkjetLegacyImportError} — nothing partial is ever stored.
 */
const WorkjetLegacyImportRpcError = Schema.Union([
  WorkjetLegacyImportError,
  EnvironmentAuthorizationError,
]);

export const WsWorkjetLegacyImportInspectRpc = Rpc.make(WS_METHODS.workjetLegacyImportInspect, {
  payload: WorkjetLegacyImportInspectInput,
  success: WorkjetLegacyImportInspection,
  error: WorkjetLegacyImportRpcError,
});

export const WsWorkjetLegacyImportDecideRpc = Rpc.make(WS_METHODS.workjetLegacyImportDecide, {
  payload: WorkjetLegacyImportDecideInput,
  success: WorkjetLegacyImportDecisionResult,
  error: WorkjetLegacyImportRpcError,
});

const WorkjetSessionImportRpcError = Schema.Union([
  WorkjetSessionImportError,
  EnvironmentAuthorizationError,
]);

export const WsWorkjetSessionImportInspectRpc = Rpc.make(WS_METHODS.workjetSessionImportInspect, {
  payload: WorkjetSessionImportInspectInput,
  success: WorkjetSessionImportInspection,
  error: WorkjetSessionImportRpcError,
});

export const WsWorkjetSessionImportRpc = Rpc.make(WS_METHODS.workjetSessionImport, {
  payload: WorkjetSessionImportInput,
  success: WorkjetSessionImportResult,
  error: WorkjetSessionImportRpcError,
});

/**
 * The client-facing half of the durable Workjet mailbox. Same delivery service,
 * same bounded schemas, and the same orchestrator-only authorization decision
 * the MCP tools make — the caller simply arrives over the WebSocket instead of
 * through a per-session MCP credential, so the payload names the SOURCE thread
 * and the server proves that thread's role before writing anything durable.
 */
const WorkjetMailboxRpcError = Schema.Union([WorkjetMailboxError, EnvironmentAuthorizationError]);

export const WsWorkjetMailboxSendMessageRpc = Rpc.make(WS_METHODS.workjetMailboxSendMessage, {
  payload: WorkjetMailboxSendMessageRpcInput,
  success: WorkjetMailboxSendMessageRpcResult,
  error: WorkjetMailboxRpcError,
});

export const WsWorkjetMailboxDelegateTaskRpc = Rpc.make(WS_METHODS.workjetMailboxDelegateTask, {
  payload: WorkjetMailboxDelegateTaskRpcInput,
  success: WorkjetMailboxDelegateTaskRpcResult,
  error: WorkjetMailboxRpcError,
});

export const WsWorkjetMailboxReplyRpc = Rpc.make(WS_METHODS.workjetMailboxReply, {
  payload: WorkjetMailboxReplyRpcInput,
  success: WorkjetMailboxReplyRpcResult,
  error: WorkjetMailboxRpcError,
});

export const WsWorkjetMailboxRequestReviewRpc = Rpc.make(WS_METHODS.workjetMailboxRequestReview, {
  payload: WorkjetMailboxRequestReviewRpcInput,
  success: WorkjetMailboxRequestReviewRpcResult,
  error: WorkjetMailboxRpcError,
});

export const WsWorkjetMailboxUpdateDelegationRpc = Rpc.make(
  WS_METHODS.workjetMailboxUpdateDelegation,
  {
    payload: WorkjetMailboxUpdateDelegationRpcInput,
    success: WorkjetMailboxUpdateDelegationRpcResult,
    error: WorkjetMailboxRpcError,
  },
);

/**
 * ADDITIVE Wave-5 write. Reassign a still-pending delegation to a different
 * LOCAL target thread. It mirrors the update RPC exactly — same bounded error
 * union, same `orchestration:operate` scope, same orchestrator-source
 * validation — and adds no new failure vocabulary: a cross-environment target
 * is `unknown-target`, anything not `delivered`/`needs-input` is
 * `invalid-state-transition`.
 */
export const WsWorkjetMailboxReassignDelegationRpc = Rpc.make(
  WS_METHODS.workjetMailboxReassignDelegation,
  {
    payload: WorkjetMailboxReassignDelegationRpcInput,
    success: WorkjetMailboxReassignDelegationRpcResult,
    error: WorkjetMailboxRpcError,
  },
);

/**
 * ADDITIVE (thread-handoff slice). Hand this thread's work to another machine.
 *
 * The context snapshot is composed and stored SERVER-side and its digest is
 * derived from the bytes the server wrote, exactly as the delegation prompt is:
 * no caller-supplied digest is ever trusted. `orchestration:operate`, with the
 * same orchestrator-source validation as every other thread-scoped send.
 */
export const WsWorkjetMailboxSendHandoffRpc = Rpc.make(WS_METHODS.workjetMailboxSendHandoff, {
  payload: WorkjetMailboxSendHandoffRpcInput,
  success: WorkjetMailboxSendHandoffRpcResult,
  error: WorkjetMailboxRpcError,
});

/**
 * ADDITIVE (thread-handoff slice). The bounded inbox of handoffs THIS machine
 * received, so a surface can offer "Continue here". Ids, addresses, timestamps,
 * bounded note and branch metadata — never the snapshot text.
 */
export const WsWorkjetMailboxListHandoffsRpc = Rpc.make(WS_METHODS.workjetMailboxListHandoffs, {
  payload: WorkjetMailboxListHandoffsRpcInput,
  success: WorkjetMailboxListHandoffsRpcResult,
  error: WorkjetMailboxRpcError,
});

/**
 * ADDITIVE (thread-handoff slice). Continue a received handoff in a NEW local
 * thread seeded with the stored snapshot. A handoff is accepted AT MOST ONCE: a
 * second accept is `invalid-state-transition`, never a second thread.
 */
export const WsWorkjetMailboxAcceptHandoffRpc = Rpc.make(WS_METHODS.workjetMailboxAcceptHandoff, {
  payload: WorkjetMailboxAcceptHandoffRpcInput,
  success: WorkjetMailboxAcceptHandoffRpcResult,
  error: WorkjetMailboxRpcError,
});

const WorkjetCrossModeRpcError = Schema.Union([
  WorkjetCrossModeError,
  EnvironmentAuthorizationError,
]);

/**
 * ADDITIVE (cross-mode workflow bridge). `Delegate to Code` / `Open in Code`:
 * create OR select the Code thread that implements a Business OS object.
 *
 * The payload carries no `environmentId`: the Code authority is this server and
 * is filled in server-side, and the CTOX authority the payload DOES name is
 * re-verified against the instance this server can independently observe. A
 * renderer-invented authority is refused with `unverified-authority`, never
 * honoured. `orchestration:operate` — it can create a thread and start a turn.
 */
export const WsWorkjetCrossModeOpenInCodeRpc = Rpc.make(WS_METHODS.workjetCrossModeOpenInCode, {
  payload: WorkjetCrossModeOpenInCodeRpcInput,
  success: WorkjetCrossModeOpenInCodeRpcResult,
  error: WorkjetCrossModeRpcError,
});

/**
 * ADDITIVE (cross-mode workflow bridge). The Code-side backlink read: does this
 * thread carry a cross-mode link, and to which Business OS object. Typed
 * references and the bounded redacted title/subtitle only — never a record.
 */
export const WsWorkjetCrossModeGetThreadLinkRpc = Rpc.make(
  WS_METHODS.workjetCrossModeGetThreadLink,
  {
    payload: WorkjetCrossModeGetThreadLinkRpcInput,
    success: WorkjetCrossModeGetThreadLinkRpcResult,
    error: WorkjetCrossModeRpcError,
  },
);

/** ADDITIVE (cross-mode workflow bridge). Bounded listing of this server's links. */
export const WsWorkjetCrossModeListLinksRpc = Rpc.make(WS_METHODS.workjetCrossModeListLinks, {
  payload: WorkjetCrossModeListLinksRpcInput,
  success: WorkjetCrossModeListLinksRpcResult,
  error: WorkjetCrossModeRpcError,
});

/**
 * ADDITIVE (cross-mode workflow bridge). `Return to Business OS`: submit a
 * result with evidence, request a review, or ask for a follow-up on the linked
 * Business OS object.
 *
 * The link id is the only authority reference on the wire — the instance,
 * module, and object are read from the stored link — and the command leaves
 * this server only through the validated CTOX MCP command path.
 */
export const WsWorkjetCrossModeSubmitRpc = Rpc.make(WS_METHODS.workjetCrossModeSubmit, {
  payload: WorkjetCrossModeSubmitRpcInput,
  success: WorkjetCrossModeSubmitRpcResult,
  error: WorkjetCrossModeRpcError,
});

export const WsWorkjetDecisionHubListConnectionsRpc = Rpc.make(
  WS_METHODS.workjetDecisionHubListConnections,
  {
    payload: Schema.Struct({}),
    success: WorkjetDecisionHubListResult,
    error: Schema.Union([WorkjetDecisionHubConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkjetDecisionHubProvisionConnectionRpc = Rpc.make(
  WS_METHODS.workjetDecisionHubProvisionConnection,
  {
    payload: WorkjetDecisionHubProvisionInput,
    success: WorkjetDecisionHubConnectionResult,
    error: Schema.Union([WorkjetDecisionHubConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkjetDecisionHubProbeConnectionRpc = Rpc.make(
  WS_METHODS.workjetDecisionHubProbeConnection,
  {
    payload: WorkjetDecisionHubProbeInput,
    success: WorkjetDecisionHubConnectionResult,
    error: Schema.Union([WorkjetDecisionHubConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkjetDecisionHubDisconnectConnectionRpc = Rpc.make(
  WS_METHODS.workjetDecisionHubDisconnectConnection,
  {
    payload: WorkjetDecisionHubDisconnectInput,
    success: WorkjetDecisionHubDisconnectResult,
    error: Schema.Union([WorkjetDecisionHubConnectionError, EnvironmentAuthorizationError]),
  },
);

/**
 * ADDITIVE Wave-5 read. The bounded, redacted list of mesh peers this machine
 * has exchanged envelopes with, plus its own address, so the composer can offer
 * cross-machine recipients instead of demanding a hand-typed environment id.
 * Ids and timestamps only — never pinned key material.
 */
export const WsWorkjetMeshRosterRpc = Rpc.make(WS_METHODS.workjetMeshRoster, {
  payload: Schema.Struct({}),
  success: WorkjetMeshRoster,
  error: WorkjetMailboxRpcError,
});

/**
 * The global multi-computer activity overview: every peer machine this one has
 * exchanged envelopes with, as this machine LAST KNEW it — identity, trust
 * level, first contact, last inbound/outbound envelope timestamps, and
 * delegation counts by lifecycle state. Ids, timestamps, and counts only.
 *
 * There is deliberately no liveness field; see `WorkjetMeshOverview` for why
 * no honest one exists.
 */
export const WsWorkjetMeshOverviewRpc = Rpc.make(WS_METHODS.workjetMeshOverview, {
  payload: Schema.Struct({}),
  success: WorkjetMeshOverview,
  error: WorkjetMailboxRpcError,
});

/**
 * Destroy one peer's pinned mesh keys, so the next envelope that verifies from
 * that address establishes a FRESH pin.
 *
 * This is the operator recovery path out of a key rotation, which
 * trust-on-first-use otherwise refuses forever. It is the only mesh-trust write
 * in the RPC surface and it destroys a security binding, so it carries the
 * `orchestration:operate` scope, never the roster's read scope — see
 * {@link WorkjetMeshRevokePeerInput} for the full argument that revocation is
 * not itself an attack.
 *
 * The payload is an ADDRESS, never key material, and the result is a bounded
 * outcome literal: nothing about the destroyed keys crosses the wire.
 */
export const WsWorkjetMeshRevokePeerRpc = Rpc.make(WS_METHODS.workjetMeshRevokePeer, {
  payload: WorkjetMeshRevokePeerInput,
  success: WorkjetMeshRevokePeerResult,
  error: WorkjetMailboxRpcError,
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

export const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

/**
 * The line counts for rows already on the page. Its own call because on GitHub the pair costs
 * 40-60% of the listing read that answers everything else on the row, so the rows arrive first
 * and their stats a moment later.
 */
export const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

export const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

export const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSetThreadResolutionRpc = Rpc.make(
  WS_METHODS.pullRequestsSetThreadResolution,
  {
    payload: PullRequestThreadResolutionInput,
    success: Schema.Void,
    error: PullRequestRpcError,
  },
);

export const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

/**
 * Read on its own rather than as part of the detail: the people who may be asked are only wanted
 * once somebody opens the menu, and reading them with every change request would spend a request
 * per host on a list nobody looked at.
 */
export const WsPullRequestsReviewerCandidatesRpc = Rpc.make(
  WS_METHODS.pullRequestsReviewerCandidates,
  {
    payload: PullRequestRef,
    success: PullRequestReviewerCandidateList,
    error: PullRequestRpcError,
  },
);

export const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({
      configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
    }),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationRpcSchemas.getWorkflowScript.input,
    success: OrchestrationRpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * The bounded, redacted Workjet mailbox audit/observability event stream. Each
 * emitted value is a {@link WorkjetMailboxAuditEvent} carrying only ids,
 * addresses, states, dispositions, reason codes, counters, and timestamps —
 * never prompt text, payloads, secrets, or artifact contents.
 */
export const WsSubscribeWorkjetMailboxAuditRpc = Rpc.make(WS_METHODS.subscribeWorkjetMailboxAudit, {
  payload: Schema.Struct({}),
  success: WorkjetMailboxAuditEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerGetUsageSummaryRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsWorkjetGreppyInspectRpc,
  WsWorkjetHarnessInspectRpc,
  WsWorkjetGreppyInstallRpc,
  WsWorkjetWorktreesInspectRpc,
  WsWorkjetGatewayStatusRpc,
  WsWorkjetGatewayCatalogRpc,
  WsWorkjetGatewayStartRpc,
  WsWorkjetGatewayStopRpc,
  WsWorkjetGatewayOauthStartRpc,
  WsWorkjetGatewayOauthPollRpc,
  WsWorkjetGatewayOauthCancelRpc,
  WsWorkjetGatewayAddApiKeyAccountRpc,
  WsWorkjetGatewayRemoveAccountRpc,
  WsWorkjetGatewayHealthRpc,
  WsWorkjetGatewayDiscoverModelsRpc,
  WsWorkjetGatewayUpdateRoutingRpc,
  WsWorkjetLegacyImportInspectRpc,
  WsWorkjetLegacyImportDecideRpc,
  WsWorkjetSessionImportInspectRpc,
  WsWorkjetSessionImportRpc,
  WsWorkjetMailboxSendMessageRpc,
  WsWorkjetMailboxDelegateTaskRpc,
  WsWorkjetMailboxReplyRpc,
  WsWorkjetMailboxRequestReviewRpc,
  WsWorkjetMailboxUpdateDelegationRpc,
  WsWorkjetMailboxReassignDelegationRpc,
  WsWorkjetMailboxSendHandoffRpc,
  WsWorkjetMailboxListHandoffsRpc,
  WsWorkjetMailboxAcceptHandoffRpc,
  WsWorkjetCrossModeOpenInCodeRpc,
  WsWorkjetCrossModeGetThreadLinkRpc,
  WsWorkjetCrossModeListLinksRpc,
  WsWorkjetCrossModeSubmitRpc,
  WsWorkjetDecisionHubListConnectionsRpc,
  WsWorkjetDecisionHubProvisionConnectionRpc,
  WsWorkjetDecisionHubProbeConnectionRpc,
  WsWorkjetDecisionHubDisconnectConnectionRpc,
  WsWorkjetMeshRosterRpc,
  WsWorkjetMeshOverviewRpc,
  WsWorkjetMeshRevokePeerRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsSubscribeWorkjetMailboxAuditRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetWorkflowScriptRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
