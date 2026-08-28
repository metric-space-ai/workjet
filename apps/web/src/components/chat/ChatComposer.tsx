import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  WorkjetThreadRole,
} from "@t3tools/contracts";
import {
  composeWorkjetWorkerManagedInstructions,
  DEFAULT_WORKJET_THREAD_CONFIG,
  normalizeWorkjetThreadConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type WorkjetGatewayModelSummary,
  WorkjetConnectionId,
  type WorkjetCapabilityBinding,
  type WorkjetThreadConfig,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  shouldSubmitComposerOnEnter,
} from "../../composer-logic";
import { deriveComposerSendState, readFileAsDataUrl } from "../ChatView.logic";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { providerInstanceIdForHarness } from "./ComposerWorkerControl";
import { workerReasoningSelections } from "./workerReasoning";
import { getProviderModelCapabilities } from "../../providerModels";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { compressImageForStash, compressImageToByteLimit } from "../../lib/imageCompression";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { resolveShortcutCommand } from "../../keybindings";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { type ElementContextDraft } from "../../lib/elementContext";
import { ComposerPendingElementContexts } from "./ComposerPendingElementContexts";
import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";
import { ComposerPreviewAnnotationCards } from "./ComposerPreviewAnnotationCards";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerFooterControls, composerFooterRowCountForWidth } from "./ComposerFooterControls";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import {
  COMPOSER_COMPUTER_LOCKED_REASON,
  ComposerComputerControl,
  ComposerManualTargetControls,
  ComposerSystemPromptControl,
  ComposerWorkjetCompactMenuContent,
  GREPPY_CAPABILITY_ID,
  harnessForProviderInstanceId,
  WorkjetCapabilityMenu,
  type WorkjetSelectableRole,
} from "./workjetSurfaces";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import {
  businessOsCodeScopeContainsEnvironment,
  useBusinessOsCodeScope,
} from "../../businessOsCodeScope";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../pierre-icons";
import { cn, randomUUID } from "~/lib/utils";

type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

function ComposerCommandMenuLayer(props: { anchor: HTMLElement | null; children: ReactNode }) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const next = {
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24),
        width: rect.width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (observer) {
      // The composer is centered and capped at a max width, so opening a side
      // panel slides it sideways without ever resizing it. Watching the anchor
      // alone would leave the menu behind; the ancestors are what shrink, and
      // they resize on every frame of the panel animation.
      observer.observe(anchor);
      for (let element = anchor.parentElement; element; element = element.parentElement) {
        observer.observe(element);
      }
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.anchor]);

  if (!position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import { getProviderDisplayName, getProviderInteractionModeToggle } from "../../providerModels";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  resolveProviderDriverKindForInstanceSelection,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import {
  deriveLatestContextWindowSnapshot,
  formatProviderDisplayName,
} from "../../lib/contextWindow";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { ReviewCommentContext } from "../../reviewCommentContext";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.isPreparingWorktree ? (
        <span className="text-secondary-label text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  insertTextAtEnd: (text: string, options?: { ensureLeadingBoundary?: boolean }) => boolean;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
    elementContexts: ElementContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  };
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isPreparingWorktree: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;

  // Mode / Workjet
  interactionMode: ProviderInteractionMode;
  /**
   * The current thread's Workjet role, or `null` on a draft thread that has no
   * server-side configuration yet. It drives the `Code | Orchestrator` control,
   * which sits BESIDE the provider-specific Plan/Build toggle.
   */
  workjetRole: WorkjetThreadRole | null;
  workjetGreppyEnabled: boolean | null;
  /**
   * The "Send to worker" affordance, supplied only for an ORCHESTRATOR thread.
   * The composer owns the slot, not the decision: role, recipients and the
   * mailbox RPCs all live with the caller.
   *
   * It is a RENDER function rather than a node because only the composer knows
   * whether the footer has collapsed: the full footer gets the labelled
   * control, the compact footer the icon-only one.
   */
  workjetSendToWorkerControl?: (options: { readonly compact: boolean }) => ReactNode;
  workjetCapabilityBusy: boolean;
  workjetCapabilityDisabled: boolean;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerElementContextsRef: React.RefObject<ElementContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  toggleInteractionMode: () => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onWorkjetGreppyEnabledChange: (enabled: boolean) => void;
  /** Toggles any capability the host can activate, not only Greppy. */
  onWorkjetCapabilityEnabledChange?: ((capabilityId: string, enabled: boolean) => void) | undefined;
  /**
   * Sets the thread's capability list and/or managed instructions in ONE
   * dispatch (worker-bundle apply, custom system prompt).
   */
  onWorkjetConfigApply?:
    | ((input: {
        readonly capabilityIds?: ReadonlyArray<string>;
        readonly managedInstructions?: string;
        readonly capabilityBindings?: ReadonlyArray<WorkjetCapabilityBinding>;
      }) => void)
    | undefined;
  workjetEnabledCapabilityIds?: ReadonlyArray<string> | undefined;
  workjetCapabilityBindings?: ReadonlyArray<WorkjetCapabilityBinding> | undefined;
  /** The thread's managed instructions, `null` on a draft thread. */
  workjetManagedInstructions: string | null;
  /**
   * Environments the current DRAFT can move to (same logical project). A
   * computer whose environment is not in this list renders as unavailable for
   * this project. Device pairing is a separate Business OS relation.
   */
  selectableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Moves a draft to another environment; the caller guards started threads. */
  onDraftEnvironmentChange?: ((environmentId: EnvironmentId) => void) | undefined;
  onWorkjetRoleChange: (role: WorkjetSelectableRole) => void;
  /** Routes to Settings → Workjet; the composer never hosts a second surface. */
  onOpenWorkjetSettings: () => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    isConnecting,
    isSendBusy,
    sendDisabledReason,
    isPreparingWorktree,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    interactionMode,
    workjetRole,
    workjetGreppyEnabled,
    workjetSendToWorkerControl,
    workjetCapabilityBusy,
    workjetCapabilityDisabled,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeThreadActivities,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    promptRef,
    composerRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerElementContextsRef,
    onSend,
    onInterrupt,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    getModelDisabledReason,
    toggleInteractionMode,
    handleInteractionModeChange,
    onWorkjetGreppyEnabledChange,
    onWorkjetCapabilityEnabledChange,
    onWorkjetConfigApply,
    workjetEnabledCapabilityIds,
    workjetCapabilityBindings,
    workjetManagedInstructions,
    selectableEnvironmentIds,
    onDraftEnvironmentChange,
    onWorkjetRoleChange,
    onOpenWorkjetSettings,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
  } = props;

  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerElementContexts = composerDraft.elementContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftElementContext = useComposerDraftStore(
    (store) => store.removeElementContext,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.session?.providerInstanceId ??
    activeThreadModelSelection?.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider;

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(
      providerInstanceEntries,
      providerStatuses,
      explicitSelectedInstanceId,
    ) ??
    providerInstanceEntries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const requestedDriverKind: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const lockedContinuationGroupKey = useMemo((): string | null => {
    if (!lockedProvider || !activeThread) return null;
    const lockedInstanceId =
      activeThread.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId;
    if (!lockedInstanceId) return null;
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
        ?.continuationGroupKey ?? null
    );
  }, [
    activeThread,
    activeThreadModelSelection?.instanceId,
    lockedProvider,
    providerInstanceEntries,
  ]);

  // Resolve which configured instance the composer is currently targeting.
  // Priority:
  //   1. The composer draft's `activeProvider` — the user's unsaved pick
  //      from the model picker (must win, otherwise the UI appears to
  //      ignore picker selections).
  //   2. Thread's persisted instance id (server-side saved selection).
  //   3. Project default's instance id.
  //   4. First enabled entry matching the current driver kind.
  //   5. First enabled entry overall / default instance for the kind.
  //
  const selectedInstanceId = useMemo<ProviderInstanceId>(() => {
    const candidates: Array<string | null | undefined> = [
      composerDraft.activeProvider,
      activeThread?.session?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const match = providerInstanceEntries.find(
        (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
      );
      if (match) {
        // When locked to a specific driver kind, ignore persisted instance
        // ids from a different kind or continuation group.
        if (lockedProvider && match.driverKind !== lockedProvider) continue;
        if (
          lockedContinuationGroupKey &&
          match.continuationGroupKey !== lockedContinuationGroupKey
        ) {
          continue;
        }
        return match.instanceId;
      }
    }
    const compatibleEntries = providerInstanceEntries.filter(
      (entry) =>
        (!lockedProvider || entry.driverKind === lockedProvider) &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    const requestedDriverEntries = compatibleEntries.filter(
      (entry) => entry.driverKind === requestedDriverKind,
    );
    return (
      resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined)?.instanceId ??
      resolveSelectableProviderInstanceEntry(compatibleEntries, undefined)?.instanceId ??
      NO_PROVIDER_MODEL_SELECTION.instanceId
    );
  }, [
    activeProjectDefaultModelSelection?.instanceId,
    activeThread?.session?.providerInstanceId,
    activeThreadModelSelection?.instanceId,
    composerDraft.activeProvider,
    lockedContinuationGroupKey,
    lockedProvider,
    providerInstanceEntries,
    requestedDriverKind,
  ]);

  // Resolve the active instance's snapshot by `instanceId` so a custom
  // instance gets its own slash commands, skills, and model list — not
  // the first snapshot for the same driver kind.
  const selectedProviderEntry = useMemo(
    () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
    [providerInstanceEntries, selectedInstanceId],
  );
  const noProviderAvailable = selectedProviderEntry === undefined;
  // The driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind;

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  // Plan mode is a legacy feature behind Settings → Beta. With the flag off,
  // ChatView forces the effective mode to "default", so hiding the toggle
  // can't trap anyone in plan mode.
  const planModeUiEnabled = settings.planModeEnabled;
  const composerProviderControls = useMemo(
    () => ({
      showInteractionModeToggle:
        planModeUiEnabled && getProviderInteractionModeToggle(providerStatuses, selectedProvider),
    }),
    [planModeUiEnabled, providerStatuses, selectedProvider],
  );
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThreadActivities ?? []),
    [activeThreadActivities],
  );
  const activeThreadProviderDisplayName = useMemo(() => {
    if (!activeThreadModelSelection) return null;
    const entry = providerStatuses.find(
      (p) => p.instanceId === activeThreadModelSelection.instanceId,
    );
    if (entry) {
      return getProviderDisplayName(providerStatuses, entry.driver);
    }
    return formatProviderDisplayName(activeThreadModelSelection.instanceId);
  }, [providerStatuses, activeThreadModelSelection]);

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  /**
   * Saved Workjet workers, offered as the bar's leftmost choice. `null` is
   * manual — the individual model and effort controls apply, exactly as
   * before — so a setup with no saved workers behaves as it always has.
   * `settings.workjet` is required-with-default in the contract, so no
   * optional chain: the one at the footer never had one either.
   */
  const businessOsCodeScope = useBusinessOsCodeScope();
  const workjetComputers = useMemo(
    () =>
      settings.workjet.computers.filter((computer) =>
        businessOsCodeScopeContainsEnvironment(businessOsCodeScope, computer.environmentId),
      ),
    [businessOsCodeScope, settings.workjet.computers],
  );
  const scopedComputerIds = useMemo(
    () => new Set(workjetComputers.map((computer) => computer.id)),
    [workjetComputers],
  );
  const workjetWorkers = useMemo(
    () =>
      settings.workjet.workerProfiles.filter((worker) => scopedComputerIds.has(worker.computerId)),
    [scopedComputerIds, settings.workjet.workerProfiles],
  );
  const workjetLlmRoutes = settings.workjet.llmRoutes;
  // Persisted with the draft (F1): the worker's model lands in the shared
  // per-instance selection, so a component-local worker choice that dies on
  // unmount left the bar in "Manual" WITH the worker's model — a corrupted
  // state the operator measured. The draft store is the single owner now.
  const selectedWorkjetWorkerId = composerDraft.workjetWorkerId ?? null;
  const setWorkjetWorkerSelection = useComposerDraftStore(
    (store) => store.setWorkjetWorkerSelection,
  );
  const setComposerDraftWorkjetConfig = useComposerDraftStore((store) => store.setWorkjetConfig);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  /**
   * Choosing a worker must MOVE the turn, not just relabel the bar. A worker
   * names a harness and a model, so both are applied together: applying the
   * model alone would run this worker's model on the previous worker's
   * runtime, which is worse than applying nothing.
   *
   * A harness this build has no runtime for changes nothing but the label —
   * guessing a runtime would send the turn somewhere unchosen.
   */
  /**
   * Worker mode hides the manual controls. A worker BUNDLES harness, model
   * and effort, so showing pickers beside it displays two sources of truth
   * for one decision — the operator called that mix a farce, correctly. The
   * pickers return the moment Manual is chosen. Mid-session switching stays
   * gated on the session-ownership migration (correction -1); this governs
   * the draft, where the next turn is composed.
   */
  const workerModeActive = selectedWorkjetWorkerId !== null;
  const selectedWorkjetWorker =
    selectedWorkjetWorkerId === null
      ? null
      : (workjetWorkers.find((candidate) => candidate.id === selectedWorkjetWorkerId) ?? null);
  const normalizedDraftWorkjetConfig = normalizeWorkjetThreadConfig(
    composerDraft.workjetConfig ?? DEFAULT_WORKJET_THREAD_CONFIG,
  );
  // A composer draft is always a root thread. Persisted worker configs are
  // rejected here instead of leaking a child role into first-turn bootstrap.
  const draftWorkjetConfig =
    normalizedDraftWorkjetConfig.role === "worker"
      ? DEFAULT_WORKJET_THREAD_CONFIG
      : normalizedDraftWorkjetConfig;
  /**
   * Worker-mode EXTRAS on a draft, held locally: the menu edits this list
   * (seeded from the worker's own `capabilityIds`), and the draft→thread
   * apply below dispatches it instead of the profile's — what the operator
   * changed in the bar wins over what the profile says. `null` means
   * untouched; the worker's list applies as-is.
   */
  const [draftWorkerCapabilityIds, setDraftWorkerCapabilityIds] =
    useState<ReadonlyArray<string> | null>(null);
  /**
   * Manual-mode custom system prompt on a draft, held locally until the
   * thread exists — the thread-config write path only exists on server
   * threads. `null` means never edited.
   */
  const [draftManagedInstructions, setDraftManagedInstructions] = useState<string | null>(null);
  /**
   * Apply the selected worker's EXTRAS and TASK TEXT once the draft becomes a
   * server thread — one dispatch, because the caller's in-flight guard drops
   * concurrent config changes. A manual draft with a locally edited system
   * prompt takes the same path with only `managedInstructions` set. The ref
   * guards against re-applying on every render and against overriding what
   * the operator changes afterwards.
   */
  const appliedWorkerCapabilitiesRef = useRef<string | null>(null);
  const composerTargetIsThread =
    typeof composerDraftTarget === "object" && composerDraftTarget !== null;
  useEffect(() => {
    if (!composerTargetIsThread || onWorkjetConfigApply === undefined) return;
    const worker =
      selectedWorkjetWorkerId === null
        ? undefined
        : workjetWorkers.find((candidate) => candidate.id === selectedWorkjetWorkerId);
    let payload: {
      readonly capabilityIds?: ReadonlyArray<string>;
      readonly managedInstructions?: string;
    };
    if (worker !== undefined) {
      // Model rules travel with every worker on this model (the Swift app's
      // Modellregeln), ahead of the worker's own task.
      const modelRules = settings.workjet.modelPrompts
        .find((entry) => entry.modelId === worker.modelId)
        ?.prompt.trim();
      payload = {
        capabilityIds: draftWorkerCapabilityIds ?? worker.capabilityIds,
        managedInstructions: composeWorkjetWorkerManagedInstructions(worker, modelRules, {
          currentWorkerId: worker.id,
          workers: workjetWorkers,
          graph: settings.workjet.workerGraph,
        }),
      };
    } else if (draftManagedInstructions !== null) {
      payload = { managedInstructions: draftManagedInstructions };
    } else {
      return;
    }
    const targetKey = JSON.stringify(composerDraftTarget);
    if (appliedWorkerCapabilitiesRef.current === targetKey) return;
    appliedWorkerCapabilitiesRef.current = targetKey;
    onWorkjetConfigApply(payload);
  }, [
    composerDraftTarget,
    composerTargetIsThread,
    draftManagedInstructions,
    draftWorkerCapabilityIds,
    onWorkjetConfigApply,
    selectedWorkjetWorkerId,
    settings.workjet.modelPrompts,
    settings.workjet.workerGraph,
    workjetWorkers,
  ]);
  /**
   * Manual-mode system prompt, parked while a worker is selected: entering
   * worker mode rightly clears the bar's local edits, but a prompt typed in
   * Manual must survive a worker round-trip (Befund K-AH1).
   */
  const manualInstructionsReturnRef = useRef<string | null>(null);
  const manualWorkjetConfigReturnRef = useRef<WorkjetThreadConfig | null>(null);
  const handleSelectWorkjetWorker = useCallback(
    (workerId: string | null) => {
      // A different choice invalidates the local bar edits: extras belong to
      // the newly chosen worker, and a worker carries its own task text.
      setDraftWorkerCapabilityIds(null);
      if (workerId !== null && selectedWorkjetWorkerId === null) {
        manualInstructionsReturnRef.current = draftManagedInstructions;
        manualWorkjetConfigReturnRef.current = draftWorkjetConfig;
      }
      setDraftManagedInstructions(workerId === null ? manualInstructionsReturnRef.current : null);
      if (workerId === null) {
        manualInstructionsReturnRef.current = null;
        // Back to Manual: restore the model that was chosen BEFORE the worker
        // took over the shared selection — without this, the worker's model
        // stays behind masquerading as a manual choice (F1).
        const manualReturn = composerDraft.workjetManualReturn;
        setWorkjetWorkerSelection(composerDraftTarget, null, null);
        setComposerDraftWorkjetConfig(
          composerDraftTarget,
          manualWorkjetConfigReturnRef.current ?? DEFAULT_WORKJET_THREAD_CONFIG,
        );
        manualWorkjetConfigReturnRef.current = null;
        if (manualReturn !== null) {
          onProviderModelSelect(manualReturn.provider, manualReturn.model);
        }
        return;
      }
      const worker = workjetWorkers.find((candidate) => candidate.id === workerId);
      if (worker === undefined) return;
      const modelRules = settings.workjet.modelPrompts
        .find((entry) => entry.modelId === worker.modelId)
        ?.prompt.trim();
      setComposerDraftWorkjetConfig(composerDraftTarget, {
        schemaVersion: 2,
        role: worker.role,
        parent: null,
        managedInstructions: composeWorkjetWorkerManagedInstructions(worker, modelRules, {
          currentWorkerId: worker.id,
          workers: workjetWorkers,
          graph: settings.workjet.workerGraph,
        }),
        enabledCapabilityIds: worker.capabilityIds,
        capabilityBindings: worker.capabilityBindings,
      });
      // Entering worker mode from Manual snapshots the manual model for the
      // way back; worker-to-worker switches keep the original snapshot.
      setWorkjetWorkerSelection(
        composerDraftTarget,
        workerId,
        selectedWorkjetWorkerId === null
          ? { provider: selectedInstanceId, model: selectedModel }
          : (composerDraft.workjetManualReturn ?? null),
      );

      // Apply the worker's COMPUTER: a worker names where it runs, so a
      // draft moves to that computer's environment through the same path the
      // environment selector uses. Only drafts move — a started thread's
      // session owns its environment. An unresolvable computer changes
      // nothing; the Computer control shows the mismatch instead of lying.
      if (!composerTargetIsThread && onDraftEnvironmentChange !== undefined) {
        const workerEnvironmentId = workjetComputers.find(
          (computer) => computer.id === worker.computerId,
        )?.environmentId;
        if (
          workerEnvironmentId !== undefined &&
          workerEnvironmentId !== environmentId &&
          selectableEnvironmentIds.includes(workerEnvironmentId)
        ) {
          onDraftEnvironmentChange(workerEnvironmentId);
        }
      }

      const instanceId = providerInstanceIdForHarness(worker.harness);
      if (instanceId === null || !worker.modelId) return;
      const targetInstance = ProviderInstanceId.make(instanceId);
      onProviderModelSelect(targetInstance, worker.modelId);

      // Effort too, but only where the provider offers that exact value. The
      // Workjet list and a provider's own options are not the same list and
      // are mapped nowhere, so a near-miss is left alone rather than guessed.
      const status = providerStatuses.find((entry) => entry.instanceId === targetInstance);
      if (status === undefined) return;
      const selections = workerReasoningSelections({
        caps: getProviderModelCapabilities(status.models, worker.modelId, status.driver),
        reasoning: worker.reasoning,
      });
      if (selections === null) return;
      setProviderModelOptions(composerDraftTarget, status.driver, selections, {
        instanceId: targetInstance,
        model: worker.modelId,
        persistSticky: true,
      });
    },
    [
      composerDraft.workjetManualReturn,
      composerDraftTarget,
      composerTargetIsThread,
      draftManagedInstructions,
      environmentId,
      onDraftEnvironmentChange,
      onProviderModelSelect,
      providerStatuses,
      selectableEnvironmentIds,
      selectedInstanceId,
      selectedModel,
      selectedWorkjetWorkerId,
      setProviderModelOptions,
      setComposerDraftWorkjetConfig,
      setWorkjetWorkerSelection,
      workjetComputers,
      workjetWorkers,
      settings.workjet.modelPrompts,
      settings.workjet.workerGraph,
      draftWorkjetConfig,
    ],
  );

  /**
   * The Computer ("Rechner") control, selectable in BOTH modes. On a draft,
   * choosing a computer moves the draft to that computer's environment; on a
   * started server thread the control is disabled with the reason — moving a
   * live session between machines is a separate project.
   */
  const composerComputerDisabledReason =
    composerTargetIsThread || routeKind === "server"
      ? COMPOSER_COMPUTER_LOCKED_REASON
      : onDraftEnvironmentChange === undefined
        ? "This draft cannot change its environment here."
        : null;
  const workerBoundComputer =
    selectedWorkjetWorker === null
      ? null
      : (workjetComputers.find((computer) => computer.id === selectedWorkjetWorker.computerId) ??
        null);
  const activeEnvironmentComputer =
    workjetComputers.find((computer) => computer.environmentId === environmentId) ?? null;
  const composerSelectedComputerId = workerModeActive
    ? (workerBoundComputer?.id ?? null)
    : (activeEnvironmentComputer?.id ?? null);
  // Worker mode surfaces the mismatch instead of lying: the worker names a
  // computer this draft could not move to, so the thread stays where it is.
  const composerComputerMismatchNote = !workerModeActive
    ? null
    : selectedWorkjetWorker === null
      ? null
      : workerBoundComputer === null
        ? "This worker's computer is no longer in the Workjet catalog — the thread stays on its current environment."
        : workerBoundComputer.environmentId !== environmentId
          ? `${workerBoundComputer.label} does not have this project — the thread stays on its current environment.`
          : null;
  const handleSelectComposerComputer = useCallback(
    (computerId: string) => {
      if (composerTargetIsThread || onDraftEnvironmentChange === undefined) return;
      const computer = workjetComputers.find((candidate) => candidate.id === computerId);
      if (computer === undefined) return;
      if (computer.environmentId === environmentId) return;
      if (!selectableEnvironmentIds.includes(computer.environmentId)) return;
      onDraftEnvironmentChange(computer.environmentId);
    },
    [
      composerTargetIsThread,
      environmentId,
      onDraftEnvironmentChange,
      selectableEnvironmentIds,
      workjetComputers,
    ],
  );

  /**
   * Worker-mode EXTRAS resolve against the thread config on a server thread
   * and against the local draft list on a draft, so the menu exists in both
   * places and one dispatch applies the final list when the thread starts.
   */
  const workerDraftExtrasActive = workerModeActive && !composerTargetIsThread;
  const effectiveEnabledCapabilityIds = workerDraftExtrasActive
    ? (draftWorkerCapabilityIds ?? selectedWorkjetWorker?.capabilityIds ?? [])
    : composerTargetIsThread
      ? workjetEnabledCapabilityIds
      : draftWorkjetConfig.enabledCapabilityIds;
  const effectiveWorkjetGreppyEnabled = workerDraftExtrasActive
    ? (effectiveEnabledCapabilityIds ?? []).includes(GREPPY_CAPABILITY_ID)
    : composerTargetIsThread
      ? workjetGreppyEnabled
      : (effectiveEnabledCapabilityIds ?? []).includes(GREPPY_CAPABILITY_ID);
  const handleDraftWorkerCapabilityChange = useCallback(
    (capabilityId: string, enabled: boolean) => {
      const base = draftWorkerCapabilityIds ?? selectedWorkjetWorker?.capabilityIds ?? [];
      const without = base.filter((id) => id !== capabilityId);
      const next = enabled ? [...without, capabilityId] : without;
      setDraftWorkerCapabilityIds(next);
      if (selectedWorkjetWorker !== null) {
        const persisted = normalizeWorkjetThreadConfig(
          composerDraft.workjetConfig ?? draftWorkjetConfig,
        );
        const current = persisted.role === "worker" ? draftWorkjetConfig : persisted;
        setComposerDraftWorkjetConfig(composerDraftTarget, {
          ...current,
          enabledCapabilityIds: next as WorkjetThreadConfig["enabledCapabilityIds"],
          capabilityBindings: enabled
            ? current.capabilityBindings
            : current.capabilityBindings.filter((binding) => binding.capabilityId !== capabilityId),
        });
      }
    },
    [
      composerDraft.workjetConfig,
      composerDraftTarget,
      draftWorkerCapabilityIds,
      draftWorkjetConfig,
      selectedWorkjetWorker,
      setComposerDraftWorkjetConfig,
    ],
  );
  const handleDraftCapabilityChange = useCallback(
    (capabilityId: string, enabled: boolean) => {
      if (workerModeActive) {
        handleDraftWorkerCapabilityChange(capabilityId, enabled);
        return;
      }
      const without = draftWorkjetConfig.enabledCapabilityIds.filter((id) => id !== capabilityId);
      const enabledCapabilityIds = enabled
        ? [...without, capabilityId as (typeof without)[number]]
        : without;
      setComposerDraftWorkjetConfig(composerDraftTarget, {
        ...draftWorkjetConfig,
        enabledCapabilityIds,
        capabilityBindings: enabled
          ? draftWorkjetConfig.capabilityBindings
          : draftWorkjetConfig.capabilityBindings.filter(
              (binding) => binding.capabilityId !== capabilityId,
            ),
      });
    },
    [
      composerDraftTarget,
      draftWorkjetConfig,
      handleDraftWorkerCapabilityChange,
      setComposerDraftWorkjetConfig,
      workerModeActive,
    ],
  );
  const effectiveCapabilityEnabledChange = composerTargetIsThread
    ? onWorkjetCapabilityEnabledChange
    : handleDraftCapabilityChange;
  const effectiveGreppyEnabledChange = useCallback(
    (enabled: boolean) => {
      if (workerDraftExtrasActive) {
        handleDraftWorkerCapabilityChange(GREPPY_CAPABILITY_ID, enabled);
        return;
      }
      if (!composerTargetIsThread) {
        handleDraftCapabilityChange(GREPPY_CAPABILITY_ID, enabled);
        return;
      }
      onWorkjetGreppyEnabledChange(enabled);
    },
    [
      composerTargetIsThread,
      handleDraftCapabilityChange,
      handleDraftWorkerCapabilityChange,
      onWorkjetGreppyEnabledChange,
      workerDraftExtrasActive,
    ],
  );
  const effectiveWorkjetCapabilityBusy = workerDraftExtrasActive ? false : workjetCapabilityBusy;
  const effectiveWorkjetCapabilityDisabled = workerDraftExtrasActive
    ? false
    : workjetCapabilityDisabled;
  const effectiveWorkjetRole = composerTargetIsThread ? workjetRole : draftWorkjetConfig.role;
  const effectiveWorkjetRoleChange = useCallback(
    (role: WorkjetSelectableRole) => {
      if (composerTargetIsThread) {
        onWorkjetRoleChange(role);
        return;
      }
      setComposerDraftWorkjetConfig(composerDraftTarget, {
        ...draftWorkjetConfig,
        role,
      });
    },
    [
      composerDraftTarget,
      composerTargetIsThread,
      draftWorkjetConfig,
      onWorkjetRoleChange,
      setComposerDraftWorkjetConfig,
    ],
  );

  /**
   * Manual mode replaces the single provider/model picker with the Workjet
   * target controls (Harness · Provider · Model) whenever the Workjet catalog
   * exists at all. With NO computers and NO LLM routes this is a pre-Workjet
   * product install, and the classic picker stays.
   */
  const workjetManualControlsAvailable = workjetComputers.length > 0 || workjetLlmRoutes.length > 0;
  const workjetGatewayCatalogQuery = useEnvironmentQuery(
    workjetManualControlsAvailable && !workerModeActive
      ? serverEnvironment.workjetGatewayCatalog({ environmentId, input: {} })
      : null,
  );
  const decisionHubConnectionsQuery = useEnvironmentQuery(
    serverEnvironment.workjetDecisionHubConnections({ environmentId, input: {} }),
  );
  const decisionHubConnections = decisionHubConnectionsQuery.data?.connections ?? [];
  const effectiveCapabilityBindings = composerTargetIsThread
    ? (workjetCapabilityBindings ?? [])
    : draftWorkjetConfig.capabilityBindings;
  const decisionHubConnectionId =
    effectiveCapabilityBindings.find((binding) => binding.capabilityId === "decision-hub")?.target
      .connectionId ?? null;
  const handleDecisionHubConnectionChange = useCallback(
    (connectionId: string) => {
      const capabilityBindings: WorkjetCapabilityBinding[] = [
        ...effectiveCapabilityBindings.filter((binding) => binding.capabilityId !== "decision-hub"),
        {
          capabilityId: "decision-hub",
          target: {
            kind: "ctox-connection",
            connectionId: WorkjetConnectionId.make(connectionId),
          },
        },
      ];
      if (composerTargetIsThread) {
        onWorkjetConfigApply?.({ capabilityBindings });
      } else {
        setComposerDraftWorkjetConfig(composerDraftTarget, {
          ...draftWorkjetConfig,
          schemaVersion: 2,
          capabilityBindings,
        });
      }
    },
    [
      composerDraftTarget,
      composerTargetIsThread,
      draftWorkjetConfig,
      effectiveCapabilityBindings,
      onWorkjetConfigApply,
      setComposerDraftWorkjetConfig,
    ],
  );
  const selectedDecisionHubConnection = decisionHubConnections.find(
    (connection) => connection.connectionId === decisionHubConnectionId,
  );
  const decisionHubSendDisabledReason = !effectiveEnabledCapabilityIds?.includes("decision-hub")
    ? null
    : decisionHubConnectionId === null
      ? "Choose a Decision Hub CTOX connection before sending"
      : selectedDecisionHubConnection === undefined
        ? "The selected Decision Hub connection does not belong to this environment"
        : selectedDecisionHubConnection.status !== "ready"
          ? `Decision Hub is ${selectedDecisionHubConnection.status}${selectedDecisionHubConnection.reason ? `: ${selectedDecisionHubConnection.reason}` : ""}`
          : null;
  const effectiveSendDisabledReason = sendDisabledReason ?? decisionHubSendDisabledReason;
  const isSendDisabled = effectiveSendDisabledReason !== null;
  // Live per-provider model discovery — the same source the settings pools
  // use. The catalog alone lists the accounts' route PATTERNS (grok-*), which
  // read as broken entries in the picker; the discovery holds the concrete
  // model ids the providers actually serve.
  const workjetGatewayModelsQuery = useEnvironmentQuery(
    workjetManualControlsAvailable && !workerModeActive
      ? serverEnvironment.workjetGatewayModels({ environmentId, input: {} })
      : null,
  );
  // The FULL gateway catalog: the model menu groups by provider itself; a
  // separate route/provider pre-filter was the redundant third field the
  // operator rejected.
  const manualGatewayModels = useMemo(() => {
    const catalog = workjetGatewayCatalogQuery.data?.models ?? [];
    const discovery = workjetGatewayModelsQuery.data ?? null;
    if (discovery === null) return catalog;
    const concrete: WorkjetGatewayModelSummary[] = [];
    const covered = new Set<string>();
    for (const providerModels of discovery.providers) {
      if (providerModels.models.length === 0) continue;
      covered.add(providerModels.provider);
      for (const discovered of providerModels.models) {
        concrete.push({
          id: discovered.id,
          displayName: discovered.displayName,
          providers: [providerModels.provider],
          accountIds: [],
        });
      }
    }
    // Catalog patterns stay only for providers the discovery has nothing for —
    // better a wildcard than an empty group.
    const remaining = catalog.filter((entry) => {
      const provider = entry.providers[0];
      return provider === undefined || !covered.has(provider);
    });
    return [...concrete, ...remaining];
  }, [workjetGatewayCatalogQuery.data, workjetGatewayModelsQuery.data]);
  const manualModelsUnavailableReason = workjetGatewayCatalogQuery.isPending
    ? "Loading the gateway model catalog…"
    : (workjetGatewayCatalogQuery.error ??
      (workjetGatewayCatalogQuery.data === null
        ? "The Workjet gateway catalog is not available — type a model id."
        : "The gateway catalog lists no models — type a model id."));
  /**
   * The instances a manual harness choice may target: configured in this
   * build, and — on a thread locked to a continuation provider — of the
   * locked driver kind. Everything else renders disabled with the hint.
   */
  const configuredProviderInstanceIds = useMemo(
    () =>
      new Set<string>(
        providerInstanceEntries
          .filter((entry) => lockedProvider === null || entry.driverKind === lockedProvider)
          // A product-disabled instance (Cursor: "not offered for new
          // sessions") must not look pickable — its menu entry was clickable
          // with zero effect (Befund F4). Filtered here, the harness option
          // renders disabled with its reason instead.
          .filter((entry) => entry.enabled)
          .map((entry) => entry.instanceId),
      ),
    [lockedProvider, providerInstanceEntries],
  );
  const handleSelectManualHarness = useCallback(
    (harness: Parameters<typeof providerInstanceIdForHarness>[0]) => {
      const instanceId = providerInstanceIdForHarness(harness);
      if (instanceId === null || !configuredProviderInstanceIds.has(instanceId)) return;
      onProviderModelSelect(ProviderInstanceId.make(instanceId), selectedModel);
    },
    [configuredProviderInstanceIds, onProviderModelSelect, selectedModel],
  );
  const handleSelectManualModel = useCallback(
    (modelId: string) => {
      onProviderModelSelect(selectedInstanceId, modelId);
    },
    [onProviderModelSelect, selectedInstanceId],
  );

  /**
   * The custom-system-prompt affordance (manual mode). On a server thread the
   * edit dispatches immediately through the one thread-config path; on a
   * draft it is held locally and applied by the draft→thread effect above.
   */
  const handleApplyManagedInstructions = useCallback(
    (text: string) => {
      if (composerTargetIsThread) {
        onWorkjetConfigApply?.({ managedInstructions: text });
        return;
      }
      setDraftManagedInstructions(text);
      setComposerDraftWorkjetConfig(composerDraftTarget, {
        ...draftWorkjetConfig,
        managedInstructions: text,
      });
    },
    [
      composerDraftTarget,
      composerTargetIsThread,
      draftWorkjetConfig,
      onWorkjetConfigApply,
      setComposerDraftWorkjetConfig,
    ],
  );

  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [composerFooterRowCount, setComposerFooterRowCount] = useState<1 | 2 | 3>(1);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState<{ key: number; active: boolean }>({
    key: 0,
    active: false,
  });
  const isMobileViewport = useMediaQuery("max-sm");
  const isComposerCollapsedMobile =
    isMobileViewport && !forceExpandedOnMobile && !isComposerFocused;

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFooterFlowRef = useRef<HTMLDivElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const stashPulseKeyRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  /**
   * Snapshots currently being encoded, keyed by target+prompt+image ids.
   * Keyed rather than boolean so a genuinely different prompt (or a different
   * thread) can still be stashed while an earlier encode is running.
   */
  const stashInFlightRef = useRef<Set<string>>(new Set());
  /**
   * Count of pasted images still being compressed, per thread. Reserved
   * against the attachment limit so concurrent pastes can't overshoot it,
   * and checked by `submitComposer` so a send can't race an image into the
   * next draft.
   */
  const pendingImageCompressionsRef = useRef<Map<ThreadId, number>>(new Map());

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount:
          composerElementContexts.length +
          composerPreviewAnnotations.length +
          composerReviewComments.length,
      }),
    [
      composerElementContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  );

  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(planModeUiEnabled
          ? ([
              {
                id: "slash:plan",
                type: "slash-command",
                command: "plan",
                label: "/plan",
                description: "Switch this thread into plan mode",
              },
              {
                id: "slash:default",
                type: "slash-command",
                command: "default",
                label: "/default",
                description: "Switch this thread back to normal build mode",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = (selectedProviderStatus?.slashCommands ?? []).map(
        (command) => ({
          id: `provider-slash-command:${selectedProvider}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: selectedProvider,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }),
      );
      const query = composerTrigger.query.trim().toLowerCase();
      const slashCommandItems = [...builtInSlashCommandItems, ...providerSlashCommandItems];
      if (!query) {
        return slashCommandItems;
      }
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderStatus?.skills ?? [], composerTrigger.query).map(
        (skill) => ({
          id: `skill:${selectedProvider}:${skill.name}`,
          type: "skill" as const,
          provider: selectedProvider,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description:
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
        }),
      );
    }
    return [];
  }, [
    composerTrigger,
    planModeUiEnabled,
    selectedProvider,
    selectedProviderStatus,
    workspaceEntries.entries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;

  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending;
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "path") {
      return pathTriggerQuery.length === 0
        ? "Type to search project files."
        : "No matching files or folders.";
    }
    return "No matching command.";
  }, [composerTriggerKind, pathTriggerQuery.length]);

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  );
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    isSendDisabled ||
    isConnecting ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    !composerSendState.hasSendableContent;
  const collapsedComposerPrimaryActionLabel = "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftImage],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftImages],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftImage],
  );

  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) return;
      const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = removal.prompt;
      setPrompt(removal.prompt);
      removeComposerDraftTerminalContext(composerDraftTarget, contextId);
      const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
    },
    [
      composerDraftTarget,
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setPrompt,
    ],
  );

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  useEffect(() => {
    composerElementContextsRef.current = composerElementContexts;
  }, [composerElementContexts, composerElementContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    promptRef,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId, promptRef]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    const composerFooterFlow = composerFooterFlowRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    // The primary send action is a separate shrink-0 sibling of this flow.
    // Measuring the whole form made the row tiers optimistic by exactly that
    // reserved width, so a nominal one-row layout could wrap unexpectedly at
    // the boundary. Observe and measure the actual left flow instead.
    const measureComposerFooterFlowWidth = () =>
      composerFooterFlow?.clientWidth ?? measureComposerFormWidth();
    const measureFooterCompactness = (composerFormWidth = measureComposerFormWidth()) => {
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    const initialComposerFormWidth = measureComposerFormWidth();
    const initialCompactness = measureFooterCompactness(initialComposerFormWidth);
    setComposerFooterRowCount(composerFooterRowCountForWidth(measureComposerFooterFlowWidth()));
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const composerFormWidth = measureComposerFormWidth();
      const nextCompactness = measureFooterCompactness(composerFormWidth);
      const nextRowCount = composerFooterRowCountForWidth(measureComposerFooterFlowWidth());
      setComposerFooterRowCount((previous) =>
        previous === nextRowCount ? previous : nextRowCount,
      );
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
    });

    observer.observe(composerForm);
    if (composerFooterFlow) observer.observe(composerFooterFlow);
    return () => {
      observer.disconnect();
    };
  }, [
    activeThreadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    isComposerApprovalState,
    isComposerCollapsedMobile,
  ]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(composerDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          composerDraftTarget,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts, promptRef]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `${serializeComposerFileLink(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [applyPromptReplacement, handleInteractionModeChange, resolveActiveComposerTrigger],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const blurMobileComposerAfterSend = useCallback(() => {
    if (!isMobileViewport) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  }, [isMobileViewport]);

  const shouldBlurMobileComposerOnSubmit = useCallback(() => {
    if (!isMobileViewport) return false;
    if (
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      environmentUnavailable !== null ||
      phase === "running"
    ) {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    composerSendState.hasSendableContent,
    environmentUnavailable,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    noProviderAvailable,
    phase,
    showPlanFollowUpPrompt,
  ]);

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      if (noProviderAvailable || isSendDisabled) {
        event?.preventDefault();
        return;
      }
      // A send while a pasted image is still compressing would strand that
      // image: the turn snapshot wouldn't include it, and it would surface
      // in the *next* draft instead. Only oversized images hit this — small
      // files clear the pending counter within a microtask.
      if (activeThreadId && (pendingImageCompressionsRef.current.get(activeThreadId) ?? 0) > 0) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still compressing a pasted image.",
          description: "Send again once its thumbnail appears.",
        });
        return;
      }
      onSend(event);
      if (shouldBlurMobileComposerOnSubmit()) {
        blurMobileComposerAfterSend();
      }
    },
    [
      activeThreadId,
      blurMobileComposerAfterSend,
      isSendDisabled,
      noProviderAvailable,
      onSend,
      shouldBlurMobileComposerOnSubmit,
    ],
  );
  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  }, []);

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      if (!planModeUiEnabled) return false;
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if (
      key === "Enter" &&
      shouldSubmitComposerOnEnter({ isMobileViewport, shiftKey: event.shiftKey })
    ) {
      submitComposer();
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------------
  // Prompt stash (⌘S)
  // ------------------------------------------------------------------
  // One global queue. Stashed prompts carry only text + images so they can be
  // restored into any thread or provider — stash, switch, restore is the
  // whole point.
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  useEffect(() => {
    return () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    };
  }, []);

  /** Briefly highlight the badge so the save registers without a flourish. */
  const pulseStashBadge = useCallback(() => {
    stashPulseKeyRef.current += 1;
    setStashPulse({ key: stashPulseKeyRef.current, active: true });
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      stashPulseTimeoutRef.current = null;
      setStashPulse((current) => ({ ...current, active: false }));
    }, 1200);
  }, []);

  const restoreStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      // Remove first so a double activation (click + Enter) can't restore twice.
      const { entry: taken, durable } = takeStashEntry(entry.id);
      if (!taken) return;
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Restored prompt may reappear in the stash",
          description:
            "Browser storage rejected the update, so this entry could still be there after a reload.",
          data: { hideCopyButton: true },
        });
      }
      setIsStashMenuOpen(false);

      const currentPrompt = promptRef.current;
      // An image-only stash must not append blank lines to whatever is
      // already in the composer.
      const nextPrompt =
        entry.prompt.length === 0
          ? currentPrompt
          : currentPrompt.trim().length
            ? `${currentPrompt.replace(/\s+$/, "")}\n\n${entry.prompt}`
            : entry.prompt;
      const promptChanged = nextPrompt !== currentPrompt;
      if (promptChanged) {
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
        setComposerTrigger(null);
      }

      let unrestoredImageNames: string[] = [];
      if (entry.attachments.length > 0) {
        const existingIds = new Set(composerImagesRef.current.map((image) => image.id));
        // The draft store also dedupes by mimeType+sizeBytes+name, so filter
        // on the same key here. Counting a duplicate against capacity would
        // burn a slot the store then refuses to fill, pushing a genuinely
        // unique image into the overflow list for nothing.
        const existingDedupKeys = new Set(
          composerImagesRef.current.map(
            (image) => `${image.mimeType}\0${image.sizeBytes}\0${image.name}`,
          ),
        );
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - composerImagesRef.current.length,
        );
        const pending = entry.attachments.filter(
          (attachment) =>
            !existingIds.has(attachment.id) &&
            !existingDedupKeys.has(
              `${attachment.mimeType}\0${attachment.sizeBytes}\0${attachment.name}`,
            ),
        );
        // Anything past the attachment limit cannot be restored. The entry is
        // already out of the queue, so report the overflow by name instead of
        // discarding it silently.
        unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
        const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
        if (restoredImages.length > 0) {
          addComposerDraftImages(composerDraftTarget, restoredImages);
        }
      }

      // Deliberately no model/provider restore: the stash exists to carry a
      // prompt across threads and providers, so whatever the composer has
      // selected right now stays selected.

      // Each cause gets its own sentence so "too large" is never blamed for a
      // file that actually failed to decode, or for one the composer simply
      // had no room to take back.
      const missingImageReasons: string[] = [];
      if (entry.droppedImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.droppedImageNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
        );
      }
      if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.unreadableImageNames.join(", ")} could not be read when this prompt was saved.`,
        );
      }
      if (unrestoredImageNames.length > 0) {
        missingImageReasons.push(
          `${unrestoredImageNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit.`,
        );
      }
      if (missingImageReasons.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some images were not restored",
          description: missingImageReasons.join(" "),
        });
      }

      // Only yank the caret to the end when text was actually inserted;
      // restoring images alone should leave the user where they were typing.
      if (promptChanged) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      }
    },
    [
      addComposerDraftImages,
      composerDraftTarget,
      composerImagesRef,
      promptRef,
      setComposerDraftPrompt,
      takeStashEntry,
    ],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { durable } = takeStashEntry(entry.id);
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description:
            "Browser storage rejected the delete, so this prompt could reappear after a reload.",
          data: { hideCopyButton: true },
        });
      }
    },
    [takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    // Terminal-context placeholders reference live sessions the stash can't
    // round-trip, so they are stripped from the stashed prompt.
    const prompt = promptRef.current.split(INLINE_TERMINAL_CONTEXT_PLACEHOLDER).join("").trim();
    const images = [...composerImagesRef.current];
    if (prompt.length === 0 && images.length === 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    // A repeat ⌘S on the *same* still-unencoded snapshot would stash it
    // twice. Guard on the snapshot itself rather than a bare boolean: once
    // the composer has been cleared the user can type something genuinely
    // new (or switch threads) while encoding continues, and that deserves its
    // own entry.
    const snapshotKey = `${String(composerDraftTarget)}\0${prompt}\0${images
      .map((image) => image.id)
      .join(",")}`;
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    const entryId = randomUUID();
    try {
      // Persist the text-only entry *first*, then clear. Ordering matters in
      // both directions: writing before clearing means a crash or closed tab
      // mid-encode still leaves the prompt recoverable, while clearing before
      // the async image work means edits typed during encoding are not wiped.
      // Images are appended to the stored entry as they finish encoding.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
      });

      // Clearing the composer is only safe once the write actually landed.
      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "Could not stash this prompt",
          description:
            "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
          data: { hideCopyButton: true },
        });
        return;
      }
      // Written but only into the in-memory fallback (localStorage blocked):
      // the entry is visible and restorable this session, so proceed with the
      // clear, but say it won't survive a reload.
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory only for this session.",
          data: { hideCopyButton: true },
        });
      }

      // Only the prompt and images are cleared — terminal/element contexts,
      // preview annotations, and review comments are not stashable, so
      // destroying them here would be unrecoverable.
      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();

      if (evicted) {
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB. Only the stashed copy shrinks; the live attachment (and
      // anything sent without stashing) keeps the original file.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          // "too large" and "could not be read" are distinct outcomes; the
          // menu and restore toast report them separately.
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        // The second phase can be rejected on its own: the text-only entry
        // fit, but adding image payloads pushed past the quota. Disk would
        // then still hold the phase-one entry with pendingImageCount set,
        // which reads as an orphan after reload — so say so now. Gated on the
        // entry write having been durable: on the in-memory fallback nothing
        // is ever durable, and the session-only warning already covered it.
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images were not saved",
            description:
              "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        // The entry was restored or deleted before its images finished
        // encoding, so they have nowhere to land. Say so rather than letting
        // them evaporate.
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? "" : "s"} finished saving. Re-attach ${kept.length === 1 ? "it" : "them"} if you still need ${kept.length === 1 ? "it" : "them"}.`,
          data: { hideCopyButton: true },
        });
      }
    } finally {
      // Must clear on every path: a throw that left this set would wedge this
      // snapshot's ⌘S until the composer remounts.
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    clearComposerDraftPromptAndImages,
    composerDraftTarget,
    composerImagesRef,
    finalizeStashEntryImages,
    promptRef,
    pulseStashBadge,
    stashEntryToQueue,
  ]);

  const toggleStashMenu = useCallback(() => {
    setIsStashMenuOpen((open) => !open);
  }, []);

  // Close the stash menu whenever the trigger-driven command menu opens so
  // the two popovers never stack in the same layer, and when the user
  // resumes typing (the menu is a transient picker, not a panel).
  useEffect(() => {
    if (composerMenuOpen) {
      setIsStashMenuOpen(false);
    }
  }, [composerMenuOpen]);
  useEffect(() => {
    setIsStashMenuOpen(false);
  }, [prompt]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      });
      if (command !== "composer.stash") return;
      // Always claim the shortcut so the browser save dialog never opens,
      // even when the composer is in a state that can't stash.
      event.preventDefault();
      event.stopPropagation();
      if (
        isCommandPaletteOpen() ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        activePendingProgress !== null
      ) {
        return;
      }
      void stashCurrentPrompt();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activePendingProgress,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    keybindings,
    pendingUserInputs.length,
    projectSelectionRequired,
    stashCurrentPrompt,
    terminalOpen,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: images
  // ------------------------------------------------------------------
  const addComposerImages = async (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (via the pending counter)
    // before the first await, keeping the total under the limit.
    const pendingCount = pendingImageCompressionsRef.current.get(threadId) ?? 0;
    let reservedCount = composerImagesRef.current.length + pendingCount;
    const acceptedFiles: File[] = [];
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }
      acceptedFiles.push(file);
      reservedCount += 1;
    }
    setThreadError(threadId, error);
    if (acceptedFiles.length === 0) return;

    pendingImageCompressionsRef.current.set(threadId, pendingCount + acceptedFiles.length);
    try {
      const nextImages: ComposerImageAttachment[] = [];
      let compressionError: string | null = null;
      for (const file of acceptedFiles) {
        // Images over the wire cap are downscaled to fit rather than
        // refused; files already within it pass through byte-for-byte.
        const compressed = await compressImageToByteLimit(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
        if (!compressed.ok) {
          compressionError =
            compressed.reason === "unreadable"
              ? `'${file.name}' could not be read as an image.`
              : `'${file.name}' is too large to attach, even after compression.`;
          continue;
        }
        const attachmentFile = compressed.file;
        const previewUrl = URL.createObjectURL(attachmentFile);
        nextImages.push({
          type: "image",
          id: randomUUID(),
          name: attachmentFile.name || "image",
          mimeType: attachmentFile.type,
          sizeBytes: attachmentFile.size,
          previewUrl,
          file: attachmentFile,
        });
      }
      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      // Only failures are reported here. Success must not pass `null`: by
      // now other work (a failed send, an overlapping paste) may have set a
      // thread error this call knows nothing about, and clearing it would
      // swallow that message.
      if (compressionError !== null) {
        setThreadError(threadId, compressionError);
      }
    } finally {
      const remaining =
        (pendingImageCompressionsRef.current.get(threadId) ?? 0) - acceptedFiles.length;
      if (remaining > 0) {
        pendingImageCompressionsRef.current.set(threadId, remaining);
      } else {
        pendingImageCompressionsRef.current.delete(threadId);
      }
    }
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    void addComposerImages(files);
    focusComposer();
  };

  const insertComposerTextAtEnd = (
    text: string,
    options?: { ensureLeadingBoundary?: boolean },
  ): boolean => {
    if (
      text.length === 0 ||
      isConnecting ||
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      projectSelectionRequired
    ) {
      return false;
    }
    const prompt = promptRef.current;
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) && prompt.length > 0 && !/\s$/.test(prompt);
    return applyPromptReplacement(
      prompt.length,
      prompt.length,
      needsLeadingSpace ? ` ${text}` : text,
    );
  };

  // File-tree drags land as mentions. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: true }),
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (!isMobileViewport) {
      return;
    }
    if (mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const activeElement = document.activeElement;
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
        return;
      }
      if (
        composerSurface &&
        activeElement instanceof Node &&
        composerSurface.contains(activeElement)
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isMobileViewport]);

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      insertTextAtEnd: insertComposerTextAtEnd,
      openModelPicker: () => {
        setIsComposerModelPickerOpen(true);
      },
      toggleModelPicker: () => {
        setIsComposerModelPickerOpen((open) => !open);
      },
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread) return;
        const snapshot = composerEditorRef.current?.readSnapshot() ?? {
          value: promptRef.current,
          cursor: composerCursor,
          expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
          terminalContextIds: composerTerminalContexts.map((context) => context.id),
        };
        const insertion = insertInlineTerminalContextPlaceholder(
          snapshot.value,
          snapshot.expandedCursor,
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          {
            id: randomUUID(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...selection,
          },
          insertion.contextIndex,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        elementContexts: composerElementContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        providerAvailable: !noProviderAvailable,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
      }),
    }),
    [
      activeThread,
      composerDraftTarget,
      composerCursor,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      isConnecting,
      isComposerApprovalState,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacement,
      isComposerModelPickerOpen,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      noProviderAvailable,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  // Render
  // ------------------------------------------------------------------
  const renderLegacyProviderTargetControl = (compact: boolean) => {
    if (workerModeActive || workjetManualControlsAvailable) return null;
    if (noProviderAvailable) {
      return (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled
          data-chat-provider-unavailable="true"
          className="shrink-0 gap-2 px-2 text-secondary-label sm:px-3"
        >
          <CircleAlertIcon className="size-4" />
          No provider available
        </Button>
      );
    }
    return (
      <ProviderModelPicker
        compact={compact}
        activeInstanceId={selectedInstanceId}
        model={selectedModelForPickerWithCustomFallback}
        lockedProvider={lockedProvider}
        lockedContinuationGroupKey={lockedContinuationGroupKey}
        instanceEntries={providerInstanceEntries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerClassName="-ms-2.5"
        terminalOpen={terminalOpen}
        open={isComposerModelPickerOpen}
        {...(composerProviderState.modelPickerIconClassName
          ? { activeProviderIconClassName: composerProviderState.modelPickerIconClassName }
          : {})}
        onOpenChange={setIsComposerModelPickerOpen}
        getModelDisabledReason={getModelDisabledReason}
        onInstanceModelChange={onProviderModelSelect}
      />
    );
  };

  const composerSystemPromptControl =
    workerModeActive || !workjetManualControlsAvailable ? null : (
      <ComposerSystemPromptControl
        value={
          composerTargetIsThread
            ? (workjetManagedInstructions ?? "")
            : (draftManagedInstructions ?? "")
        }
        busy={workjetCapabilityBusy}
        disabled={composerTargetIsThread && workjetCapabilityDisabled}
        draftPending={!composerTargetIsThread}
        onApply={handleApplyManagedInstructions}
      />
    );

  const composerContextWindowControl = activeContextWindow ? (
    <ContextWindowMeter
      usage={activeContextWindow}
      providerDisplayName={activeThreadProviderDisplayName}
    />
  ) : null;
  const composerContextWindowMenuContent = composerContextWindowControl ? (
    <div
      className="flex items-center justify-between gap-2 px-2 py-1"
      data-composer-context-window-menu="true"
    >
      <span className="text-sm text-muted-foreground">Context window</span>
      {composerContextWindowControl}
    </div>
  ) : null;

  const composerAttachmentControl =
    !isComposerApprovalState && pendingUserInputs.length === 0 ? (
      <ComposerAttachmentMenu
        disabled={projectSelectionRequired || isConnecting}
        onAttachImages={(files) => void addComposerImages(files)}
        onAddProjectFile={() => {
          insertComposerTextAtEnd("@", { ensureLeadingBoundary: true });
        }}
      />
    ) : null;

  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className="mx-auto w-full min-w-0 max-w-5xl"
      data-chat-composer-form="true"
    >
      <div
        className={cn(
          "group rounded-[22px] p-px transition-colors duration-200",
          composerProviderState.composerFrameClassName,
        )}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        onDragEnterCapture={composerMentionDragHandlers.onDragEnter}
        onDragOverCapture={composerMentionDragHandlers.onDragOver}
        onDragLeaveCapture={onComposerMentionDragLeaveCapture}
        onDropCapture={composerMentionDragHandlers.onDrop}
      >
        <div
          ref={composerSurfaceRef}
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
          className={cn(
            "rounded-[20px] transition-[background-color] duration-200",
            isDragOverComposer ? "bg-accent/45 ring-1 ring-primary/70" : null,
            projectSelectionRequired ? "opacity-75" : null,
            composerProviderState.composerSurfaceClassName,
          )}
          onFocusCapture={(event) => {
            const activeElement = event.target;
            if (
              isComposerCollapsedMobile &&
              activeElement instanceof HTMLElement &&
              activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
            ) {
              return;
            }
            if (composerBlurFrameRef.current !== null) {
              window.cancelAnimationFrame(composerBlurFrameRef.current);
              composerBlurFrameRef.current = null;
            }
            setIsComposerFocused(true);
          }}
          onBlurCapture={() => {
            scheduleComposerCollapseCheck();
          }}
        >
          {!isComposerCollapsedMobile &&
            (activePendingApproval ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null)}

          {isComposerCollapsedMobile && activePendingApproval ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
                <ComposerPendingApprovalActions
                  requestId={activePendingApproval.requestId}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                />
              </div>
            </div>
          ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
              <div className="px-3 pb-3 sm:px-4">
                <div
                  data-chat-composer-mobile-pending-compact="true"
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                    !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                      activePendingProgress?.customAnswer ? "text-foreground" : "text-placeholder",
                      !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                    )}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandMobileComposer}
                    aria-label="Write custom answer"
                  >
                    {activePendingProgress?.customAnswer || "Write custom answer"}
                  </button>
                  {activePendingProgress?.activeQuestion?.multiSelect ? (
                    <ComposerPrimaryActions
                      compact
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={effectiveSendDisabledReason}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        noProviderAvailable ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {showCollapsedMobilePromptRow ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[14px] focus:outline-none",
                  (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                    ? "text-foreground"
                    : "text-placeholder",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={expandMobileComposer}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? activePendingProgress.customAnswer ||
                    "Type your own answer, or leave this blank to use the selected option"
                  : prompt.trim() ||
                    (noProviderAvailable ? "Enable a provider in Settings" : "Ask anything...")}
              </button>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-30"
                disabled={collapsedComposerPrimaryActionDisabled}
                aria-label={collapsedComposerPrimaryActionLabel}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  submitComposer();
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 3L8 13M8 3L4 7M8 3L12 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : null}

          <div
            ref={setComposerMenuAnchor}
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
              isComposerCollapsedMobile && "hidden",
            )}
          >
            <ComposerStashBadge
              count={stashQueue.length}
              pulseKey={stashPulse.key}
              pulsing={stashPulse.active}
              menuOpen={isStashMenuOpen}
              onToggleMenu={toggleStashMenu}
            />

            {isStashMenuOpen && !composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerStashMenu
                  entries={stashQueue}
                  onRestore={restoreStashEntry}
                  onDelete={deleteStashEntry}
                  onClose={() => setIsStashMenuOpen(false)}
                />
              </ComposerCommandMenuLayer>
            )}

            {composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  groupSlashCommandSections={
                    composerTrigger?.kind === "slash-command" &&
                    composerTrigger.query.trim().length === 0
                  }
                  emptyStateText={composerMenuEmptyState}
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </ComposerCommandMenuLayer>
            )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerPreviewAnnotations.length > 0 && (
                <ComposerPreviewAnnotationCards
                  annotations={composerPreviewAnnotations}
                  images={composerImages}
                  onRemove={(annotationId) =>
                    removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId)
                  }
                  onExpandImage={(imageId) => {
                    const preview = buildExpandedImagePreview(composerImages, imageId);
                    if (preview) onExpandImage(preview);
                  }}
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerReviewComments.length > 0 && (
                <ComposerPendingReviewComments
                  comments={composerReviewComments}
                  onRemove={(commentId) =>
                    removeComposerDraftReviewComment(composerDraftTarget, commentId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerElementContexts.length > 0 && (
                <ComposerPendingElementContexts
                  contexts={composerElementContexts}
                  onRemove={(contextId) =>
                    removeComposerDraftElementContext(composerDraftTarget, contextId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.some(
                (image) =>
                  !composerPreviewAnnotations.some((annotation) => annotation.id === image.id),
              ) && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages
                    .filter(
                      (image) =>
                        !composerPreviewAnnotations.some(
                          (annotation) => annotation.id === image.id,
                        ),
                    )
                    .map((image) => (
                      <div
                        key={image.id}
                        className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                      >
                        {image.previewUrl ? (
                          <button
                            type="button"
                            className="h-full w-full cursor-zoom-in"
                            aria-label={`Preview ${image.name}`}
                            onClick={() => {
                              const preview = buildExpandedImagePreview(composerImages, image.id);
                              if (!preview) return;
                              onExpandImage(preview);
                            }}
                          >
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-secondary-label">
                            {image.name}
                          </div>
                        )}
                        {nonPersistedComposerImageIdSet.has(image.id) && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  aria-label="Draft attachment may not persist"
                                  className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                >
                                  <CircleAlertIcon className="size-3" />
                                </span>
                              }
                            />
                            <TooltipPopup
                              side="top"
                              className="max-w-64 whitespace-normal leading-tight"
                            >
                              Draft attachment could not be saved locally and may be lost on
                              navigation.
                            </TooltipPopup>
                          </Tooltip>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                          onClick={() => removeComposerImage(image.id)}
                          aria-label={`Remove ${image.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))}
                </div>
              )}

            <div className="relative">
              <ComposerPromptEditor
                editorRef={composerEditorRef}
                value={
                  isComposerApprovalState
                    ? ""
                    : activePendingProgress
                      ? activePendingProgress.customAnswer
                      : prompt
                }
                cursor={composerCursor}
                terminalContexts={
                  !isComposerApprovalState && pendingUserInputs.length === 0
                    ? composerTerminalContexts
                    : []
                }
                skills={selectedProviderStatus?.skills ?? []}
                {...(showMobilePendingAnswerActions ? { className: "max-sm:pb-11" } : {})}
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                    : activePendingProgress
                      ? "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : projectSelectionRequired
                          ? "Choose a project above to start a thread"
                          : noProviderAvailable
                            ? "Enable a provider in Settings to send a message"
                            : activeThreadId === null
                              ? "Describe what you want to build, or add images and project files"
                              : phase === "disconnected"
                                ? "Ask for follow-up changes or attach images"
                                : "Ask anything, @tag files/folders, $use skills, or / for commands"
                }
                disabled={isConnecting || isComposerApprovalState || projectSelectionRequired}
              />
              {showMobilePendingAnswerActions ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex justify-end"
                >
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={false}
                    showPlanFollowUpPrompt={false}
                    promptHasText={false}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={effectiveSendDisabledReason}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={false}
                    hasSendableContent={false}
                    preserveComposerFocusOnPointerDown
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* Bottom toolbar */}
          {isComposerCollapsedMobile ? null : activePendingApproval ? (
            <div className="flex items-center justify-end gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
              className={cn(
                "flex min-w-0 flex-nowrap items-end justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
                pendingUserInputs.length > 0 && "pt-2",
                isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                showMobilePendingAnswerActions && "hidden sm:flex",
              )}
            >
              {/* The left flow owns the ordered Workjet controls. It wraps at
                  measured flow widths; the primary send action is bottom-
                  aligned with the last row and never overlaps the flow. */}
              <div
                ref={composerFooterFlowRef}
                className="@container/composer-controls -m-1 -ms-3.5 flex min-w-0 flex-1 flex-wrap items-start gap-1 p-1 ps-3.5"
              >
                {/* With Workjet manual controls the retired provider picker
                    stays hidden in BOTH layouts — compact used to fall back
                    to it, resurrecting the removed provider chip (K-A2). */}
                {isComposerFooterCompact ? renderLegacyProviderTargetControl(true) : null}

                {isComposerFooterCompact ? (
                  <>
                    <CompactComposerControlsMenu
                      interactionMode={interactionMode}
                      showInteractionModeToggle={
                        workerModeActive
                          ? false
                          : composerProviderControls.showInteractionModeToggle
                      }
                      workerMenuContent={
                        <ComposerWorkjetCompactMenuContent
                          workers={workjetWorkers}
                          selectedWorkerId={selectedWorkjetWorkerId}
                          onSelectWorker={handleSelectWorkjetWorker}
                          computers={workjetComputers}
                          selectedComputerId={composerSelectedComputerId}
                          activeEnvironmentId={environmentId}
                          selectableEnvironmentIds={selectableEnvironmentIds}
                          computerDisabledReason={composerComputerDisabledReason}
                          onSelectComputer={handleSelectComposerComputer}
                          manualTarget={
                            workerModeActive || !workjetManualControlsAvailable
                              ? null
                              : {
                                  configuredInstanceIds: configuredProviderInstanceIds,
                                  selectedHarness: harnessForProviderInstanceId(selectedInstanceId),
                                  onSelectHarness: handleSelectManualHarness,
                                  models: manualGatewayModels,
                                  modelsUnavailableReason:
                                    manualGatewayModels.length === 0
                                      ? manualModelsUnavailableReason
                                      : null,
                                  selectedModelId: selectedModelForPickerWithCustomFallback,
                                  onSelectModel: handleSelectManualModel,
                                }
                          }
                        />
                      }
                      traitsMenuContent={workerModeActive ? undefined : providerTraitsMenuContent}
                      contextWindowMenuContent={composerContextWindowMenuContent}
                      systemPromptMenuContent={composerSystemPromptControl}
                      workjetMenuContent={
                        effectiveWorkjetGreppyEnabled === null ? undefined : (
                          <WorkjetCapabilityMenu
                            compact
                            greppyEnabled={effectiveWorkjetGreppyEnabled}
                            busy={effectiveWorkjetCapabilityBusy}
                            disabled={effectiveWorkjetCapabilityDisabled}
                            onGreppyEnabledChange={effectiveGreppyEnabledChange}
                            onCapabilityEnabledChange={effectiveCapabilityEnabledChange}
                            enabledCapabilityIds={effectiveEnabledCapabilityIds}
                            decisionHubConnections={decisionHubConnections}
                            decisionHubConnectionId={decisionHubConnectionId}
                            onDecisionHubConnectionChange={handleDecisionHubConnectionChange}
                            workjetRole={workerModeActive ? null : effectiveWorkjetRole}
                            onWorkjetRoleChange={effectiveWorkjetRoleChange}
                          />
                        )
                      }
                      onToggleInteractionMode={toggleInteractionMode}
                    />
                    {composerAttachmentControl}
                    {workerModeActive
                      ? null
                      : (workjetSendToWorkerControl?.({ compact: true }) ?? null)}
                  </>
                ) : (
                  <ComposerFooterControls
                    workerMode={workerModeActive}
                    workjetWorkers={workjetWorkers}
                    selectedWorkjetWorkerId={selectedWorkjetWorkerId}
                    onSelectWorkjetWorker={handleSelectWorkjetWorker}
                    computerControl={
                      /* A pre-Workjet install (no computers, no llmRoutes)
                         keeps its bar unchanged. */
                      !workjetManualControlsAvailable && !workerModeActive ? null : (
                        <ComposerComputerControl
                          computers={workjetComputers}
                          selectedComputerId={composerSelectedComputerId}
                          activeEnvironmentId={environmentId}
                          selectableEnvironmentIds={selectableEnvironmentIds}
                          disabledReason={composerComputerDisabledReason}
                          mismatchNote={composerComputerMismatchNote}
                          onSelectComputer={handleSelectComposerComputer}
                          onAddComputer={() => {
                            try {
                              window.sessionStorage.setItem("workjet-computer-create", "1");
                            } catch {
                              // Without storage the page still opens.
                            }
                            window.location.hash = "#/settings/computers";
                          }}
                        />
                      )
                    }
                    providerTargetControl={renderLegacyProviderTargetControl(false)}
                    manualTargetControls={
                      workerModeActive || !workjetManualControlsAvailable ? null : (
                        <ComposerManualTargetControls
                          configuredInstanceIds={configuredProviderInstanceIds}
                          unavailableHint={
                            lockedProvider === null
                              ? undefined
                              : "Locked — this thread continues on its current provider"
                          }
                          selectedHarness={harnessForProviderInstanceId(selectedInstanceId)}
                          onSelectHarness={handleSelectManualHarness}
                          models={manualGatewayModels}
                          modelsUnavailableReason={
                            manualGatewayModels.length === 0 ? manualModelsUnavailableReason : null
                          }
                          selectedModelId={selectedModelForPickerWithCustomFallback}
                          onSelectModel={handleSelectManualModel}
                        />
                      )
                    }
                    contextWindowControl={composerContextWindowControl}
                    systemPromptControl={composerSystemPromptControl}
                    attachmentControl={composerAttachmentControl}
                    rowCount={
                      !workerModeActive && workjetManualControlsAvailable
                        ? composerFooterRowCount
                        : 1
                    }
                    traitsPicker={workerModeActive ? null : providerTraitsPicker}
                    showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                    interactionMode={interactionMode}
                    workjetRole={effectiveWorkjetRole}
                    workjetGreppyEnabled={effectiveWorkjetGreppyEnabled}
                    workjetBusy={effectiveWorkjetCapabilityBusy}
                    workjetDisabled={effectiveWorkjetCapabilityDisabled}
                    sendToWorkerControl={workjetSendToWorkerControl?.({ compact: false }) ?? null}
                    onToggleInteractionMode={toggleInteractionMode}
                    onWorkjetRoleChange={effectiveWorkjetRoleChange}
                    onWorkjetGreppyEnabledChange={effectiveGreppyEnabledChange}
                    onWorkjetCapabilityEnabledChange={effectiveCapabilityEnabledChange}
                    workjetEnabledCapabilityIds={effectiveEnabledCapabilityIds}
                    decisionHubConnections={decisionHubConnections}
                    decisionHubConnectionId={decisionHubConnectionId}
                    onDecisionHubConnectionChange={handleDecisionHubConnectionChange}
                    onOpenWorkjetSettings={onOpenWorkjetSettings}
                  />
                )}
              </div>

              {/* Right side: send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  pendingAction={pendingPrimaryAction}
                  isRunning={phase === "running"}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={isSendBusy}
                  sendDisabledReason={effectiveSendDisabledReason}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={
                    environmentUnavailable !== null ||
                    noProviderAvailable ||
                    projectSelectionRequired
                  }
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={composerSendState.hasSendableContent}
                  preserveComposerFocusOnPointerDown={isMobileViewport}
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </form>
  );
});
