import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useBusinessOsScopedEnvironments } from "~/state/environments";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { useLocalEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateCandidates,
  environmentGroupsWithUpdates,
  getProviderUpdateInitialToastView,
  localEnvironmentUpdateNotificationKey,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

/**
 * True when a desktop-local secondary backend (the parallel WSL backend) is
 * present alongside the primary. Local secondaries connect over loopback with a
 * `local:<backendInstanceId>` bearer connection id; everything else (SSH, relay,
 * remote) is ignored. Gating on this keeps non-WSL users on the unchanged
 * single-prompt flow.
 */
function useHasLocalSecondaryEnvironment(): boolean {
  const { environments } = useBusinessOsScopedEnvironments();
  return useMemo(
    () =>
      environments.some((environment) => isDesktopLocalConnectionTarget(environment.entry.target)),
    [environments],
  );
}

/**
 * Provider updates with a local secondary backend (WSL) live in Settings ›
 * Harnesses; the launch hint is the dense header chip below, not a toast.
 * Without a secondary (the common case) the single-prompt flow updates in place.
 */
export function ProviderUpdateLaunchNotification() {
  const hasLocalSecondary = useHasLocalSecondaryEnvironment();

  return hasLocalSecondary ? null : <ProviderUpdatePrimaryNotification />;
}

// While a local backend (e.g. WSL) is still connecting, defer the chip so it
// reflects every environment. Cap the wait so a stuck or failed backend can't
// suppress the primary's updates indefinitely.
const SETTLING_GRACE_MS = 30_000;

function useProviderUpdateChipView(): {
  readonly title: string;
  readonly notificationKey: string;
} | null {
  const { groups, isAnySettling } = useLocalEnvironmentUpdateGroups();
  const { dismissedNotificationKeys } = useDismissedProviderUpdateNotificationKeys();

  const updateGroups = useMemo(() => environmentGroupsWithUpdates(groups), [groups]);
  const notificationKey = useMemo(() => localEnvironmentUpdateNotificationKey(groups), [groups]);

  // Title summarizes the distinct providers on offer across all environments;
  // the per-environment detail lives in Settings › Harnesses.
  const candidateUnion = useMemo(
    () => collectProviderUpdateCandidates(updateGroups.flatMap((group) => group.candidates)),
    [updateGroups],
  );

  // Defer while any local backend is still connecting, up to the grace period.
  const [settleGraceElapsed, setSettleGraceElapsed] = useState(false);
  useEffect(() => {
    if (!isAnySettling) {
      setSettleGraceElapsed(false);
      return;
    }
    const timer = setTimeout(() => setSettleGraceElapsed(true), SETTLING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isAnySettling]);
  const isGated = isAnySettling && !settleGraceElapsed;

  if (notificationKey === null || isGated || dismissedNotificationKeys.has(notificationKey)) {
    return null;
  }

  return {
    title: getProviderUpdateInitialToastView({
      updateProviders: candidateUnion,
      oneClickProviders: candidateUnion,
    }).title,
    notificationKey,
  };
}

/**
 * Dichter Chip in der Kopfzeile statt Toast (Muster: SlowRpcRequestChip):
 * „Codex 0.162.1 verfügbar“. Klick öffnet Einstellungen › Harnesses; × merkt
 * die Ablehnung wie bisher über die verwahrten Schlüssel.
 */
export function ProviderUpdateHeaderChip() {
  const hasLocalSecondary = useHasLocalSecondaryEnvironment();
  return hasLocalSecondary ? <ProviderUpdateEnvironmentsChip /> : null;
}

function ProviderUpdateEnvironmentsChip() {
  const navigate = useNavigate();
  const { dismissNotificationKey } = useDismissedProviderUpdateNotificationKeys();
  const view = useProviderUpdateChipView();
  if (view === null) return null;
  return (
    <ProviderUpdateChipView
      title={view.title}
      onOpen={() => void navigate({ to: "/settings/harnesses" })}
      onDismiss={() => dismissNotificationKey(view.notificationKey)}
    />
  );
}

/** Reine Darstellung des Kopfzeilen-Chips, auch für die Fixture nutzbar. */
export function ProviderUpdateChipView({
  title,
  onOpen,
  onDismiss,
}: {
  readonly title: string;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <span
      className="no-drag inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 pl-2 pr-1 py-0.5 text-[11px] whitespace-nowrap text-amber-400"
      data-workjet-provider-update=""
    >
      <button
        type="button"
        className="hover:text-amber-300 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        title="Einstellungen › Harnesses"
        onClick={onOpen}
      >
        {title}
      </button>
      <button
        type="button"
        aria-label="Schließen"
        className="rounded-full px-1 text-amber-400/70 hover:text-amber-300 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onDismiss}
      >
        ×
      </button>
    </span>
  );
}
