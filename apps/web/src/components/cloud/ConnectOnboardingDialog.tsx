import { useAuth } from "@clerk/react";
import { AuthAdministrativeScopes, AuthRelayWriteScope } from "@workjet/contracts";
import { useEffect, useRef, useState } from "react";

import {
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
} from "~/cloud/connectOnboarding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { usePrimarySessionState } from "~/environments/primary";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { InlineNoticePortal, useEscapeToCancel } from "../InlineNoticeSlot";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

/**
 * Post-sign-in onboarding for Workjet Connect, inline (no modal, no wizard
 * steps): one section under the header with the publish switches (only when
 * the session may manage the relay link) and the account's devices in one
 * list. Opens on every in-session sign-in — sign-out removes the connected
 * relay environments, so each new session starts with no devices to reach. A
 * cold load with a restored session does not count as a sign-in.
 *
 * Self-contained: today it is mounted in `__root.tsx` and renders into the
 * notice slot under the header. Target mount (handover): the Workjet Connect
 * section of Settings › Instanzen, as `<ConnectOnboardingDialog />` there.
 */
export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

function ConfiguredConnectOnboardingDialog() {
  // Mirrors ManagedRelayAuthProvider: a pending Clerk session must not read as
  // signed-out, or its later activation would look like a fresh sign-in.
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const desktopBridge = window.desktopBridge;
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;
  const canManageRelay = currentSessionScopes?.includes(AuthRelayWriteScope) ?? false;
  // The publish step is only offered when we know the answer; opening the
  // wizard before the session state resolves would let the step set change
  // mid-flight. A failed session read still opens the wizard — it just means
  // no publish step.
  const sessionScopesKnown =
    Boolean(desktopBridge) ||
    primarySessionState.data !== null ||
    primarySessionState.error !== null;

  const controller = useCloudLinkController();

  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [exposeEnvironment, setExposeEnvironment] = useState(true);
  const [publishAgentActivity, setPublishAgentActivity] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const prefilledFromLinkStateRef = useRef(false);
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  const optOutAccounts = optOutState.optOutAccounts;

  // Every sign-in or account switch that completes during this session
  // requests the wizard — account transitions clear the connected relay
  // environments, so each new session starts with no devices to reach. A cold
  // load observes undefined → account and must not re-prompt.
  useEffect(() => {
    if (!isLoaded) return;
    // A loaded-but-incomplete snapshot (signed in, user id not yet populated)
    // must not be recorded as signed-out — the next render would then look
    // like a fresh sign-in on a cold load.
    if (isSignedIn && !userId) return;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    if (previousAccount !== undefined && previousAccount !== nextAccount && nextAccount !== null) {
      setRequestedAccount(nextAccount);
    }
  }, [isLoaded, isSignedIn, userId]);

  // A manageable session implies a primary environment, so when the scopes
  // allow publishing, wait for the connection target too — otherwise the
  // wizard could open on the devices step moments before the publish step
  // becomes available and freeze there.
  const publishStepDecided = !canManageRelay || controller.linkState.target !== null;

  // Open once the session scopes resolve so the step set is stable. Accounts
  // that chose "Don't show this again" are skipped.
  useEffect(() => {
    if (requestedAccount === null || openForAccount !== null) return;
    if (optOutAccounts.includes(requestedAccount)) {
      setRequestedAccount(null);
      return;
    }
    if (!sessionScopesKnown || !publishStepDecided) return;
    setRequestedAccount(null);
    prefilledFromLinkStateRef.current = false;
    setExposeEnvironment(true);
    setPublishAgentActivity(true);
    setDontShowAgain(false);
    setShowPublish(canManageRelay && controller.linkState.target !== null);
    setOpenForAccount(requestedAccount);
  }, [
    canManageRelay,
    controller.linkState.target,
    openForAccount,
    optOutAccounts,
    publishStepDecided,
    requestedAccount,
    sessionScopesKnown,
  ]);

  // Signing out (or switching accounts) mid-wizard invalidates everything the
  // wizard would do — close it and let the sign-in trigger re-evaluate.
  useEffect(() => {
    if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
      setOpenForAccount(null);
    }
    if (requestedAccount !== null && (!isSignedIn || userId !== requestedAccount)) {
      setRequestedAccount(null);
    }
  }, [isSignedIn, openForAccount, requestedAccount, userId]);

  // Toggles default on, but an environment that is already linked should show
  // its actual configuration instead of silently proposing to rewrite it.
  // Only when the link belongs to the account being onboarded, though — after
  // an account switch the cached link state can still describe the previous
  // account's setup.
  const linkStateData = controller.linkState.data;
  useEffect(() => {
    if (openForAccount === null || prefilledFromLinkStateRef.current || linkStateData === null) {
      return;
    }
    prefilledFromLinkStateRef.current = true;
    if (linkStateData.linked && linkStateData.cloudUserId === openForAccount) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
      setPublishAgentActivity(linkStateData.publishAgentActivity);
    }
  }, [linkStateData, openForAccount]);

  const complete = () => {
    // Keep the wizard up while a link request is in flight so its outcome
    // (and any failure) stays visible.
    if (isApplying) return;
    const account = openForAccount;
    setOpenForAccount(null);
    if (account !== null && dontShowAgain) {
      setOptOutState((state) =>
        state.optOutAccounts.includes(account)
          ? state
          : { optOutAccounts: [...state.optOutAccounts, account] },
      );
    }
  };

  const applyPublishSelection = async () => {
    // Onboarding only ever enables — with both switches off there is nothing
    // to apply, and an existing link must not be torn down from here.
    if (!exposeEnvironment && !publishAgentActivity) {
      complete();
      return;
    }
    setIsApplying(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: exposeEnvironment,
      publish: publishAgentActivity,
    });
    setIsApplying(false);
    if (!ok) return;
    toastManager.add({ type: "success", title: "Workjet Connect aktiv" });
    setShowPublish(false);
  };

  if (openForAccount === null) return null;

  return (
    <InlineNoticePortal>
      <ConnectOnboardingSection
        dontShowAgain={dontShowAgain}
        exposeEnvironment={exposeEnvironment}
        isApplying={isApplying}
        operationError={controller.operationError}
        publishAgentActivity={publishAgentActivity}
        publishPending={controller.linkState.isPending && linkStateData === null}
        showPublish={showPublish}
        onApply={() => void applyPublishSelection()}
        onClose={complete}
        onDontShowAgainChange={setDontShowAgain}
        onExposeEnvironmentChange={setExposeEnvironment}
        onPublishAgentActivityChange={setPublishAgentActivity}
      />
    </InlineNoticePortal>
  );
}

/** Produktname, kein übersetzbarer Text. */
const CONNECT_PRODUCT_NAME = "Workjet Connect";

/**
 * Presentational half: one inline section, no steps. Title row, the publish
 * switches when allowed, the device list, footer with „Nicht mehr anzeigen“,
 * „Später“ and the primary action.
 */
export function ConnectOnboardingSection({
  showPublish,
  exposeEnvironment,
  publishAgentActivity,
  dontShowAgain,
  isApplying,
  publishPending,
  operationError,
  onExposeEnvironmentChange,
  onPublishAgentActivityChange,
  onDontShowAgainChange,
  onApply,
  onClose,
}: {
  readonly showPublish: boolean;
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
  readonly dontShowAgain: boolean;
  readonly isApplying: boolean;
  readonly publishPending: boolean;
  readonly operationError: string | null;
  readonly onExposeEnvironmentChange: (enabled: boolean) => void;
  readonly onPublishAgentActivityChange: (enabled: boolean) => void;
  readonly onDontShowAgainChange: (enabled: boolean) => void;
  readonly onApply: () => void;
  readonly onClose: () => void;
}) {
  useEscapeToCancel(onClose, !isApplying);

  return (
    <section
      aria-label={CONNECT_PRODUCT_NAME}
      className="flex max-h-[min(28rem,60dvh)] w-full flex-col gap-3 overflow-y-auto border-b border-border bg-card px-3 py-3 text-[13.5px] sm:px-5"
      data-connect-onboarding=""
    >
      <div className="font-medium">{`${CONNECT_PRODUCT_NAME} einrichten`}</div>
      {showPublish ? (
        <div className="overflow-hidden rounded-lg border">
          <OnboardingToggleRow
            title="Umgebung veröffentlichen"
            checked={exposeEnvironment}
            disabled={isApplying}
            onCheckedChange={onExposeEnvironmentChange}
          />
          <OnboardingToggleRow
            title="Luma-Aktivität senden"
            checked={publishAgentActivity}
            disabled={isApplying}
            onCheckedChange={onPublishAgentActivityChange}
          />
        </div>
      ) : null}
      {operationError ? (
        <p className="text-xs text-destructive" role="alert">
          {operationError}
        </p>
      ) : null}
      <DevicesList />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={dontShowAgain}
            onCheckedChange={(checked) => onDontShowAgainChange(checked === true)}
          />
          Nicht mehr anzeigen
        </label>
        <div className="flex items-center gap-2">
          <Button disabled={isApplying} size="sm" variant="outline" onClick={onClose}>
            Später
          </Button>
          {showPublish ? (
            <Button disabled={isApplying || publishPending} size="sm" onClick={onApply}>
              {isApplying ? "Aktiviere…" : "Aktivieren"}
            </Button>
          ) : (
            <Button disabled={isApplying} size="sm" onClick={onClose}>
              Fertig
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function OnboardingToggleRow({
  title,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly title: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/60 px-3 py-2 first:border-t-0">
      <span className="min-w-0 truncate">{title}</span>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function DevicesList() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
        empty={<p className="px-3 py-3 text-muted-foreground">Keine weiteren Geräte</p>}
      />
    </div>
  );
}
