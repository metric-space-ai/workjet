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

/** Harness-Update als Teil des Versions-Chips (UI-Vertrag §6, Audit A-63). */
export interface ProviderUpdateHint {
  /** z. B. „Codex 0.162.1 verfügbar“ */
  readonly title: string;
  /** Öffnet Einstellungen › Harnesses. */
  readonly onOpen: () => void;
  /** Merkt die Ablehnung über die verwahrten Schlüssel. */
  readonly onDismiss: () => void;
}

/**
 * Update-Hinweis für den Versions-Chip. Nur mit lokalem Zweit-Backend (WSL);
 * sonst läuft das Update im Ein-Klick-Ablauf und es gibt keinen Hinweis.
 */
export function useProviderUpdateHint(): ProviderUpdateHint | null {
  const navigate = useNavigate();
  const hasLocalSecondary = useHasLocalSecondaryEnvironment();
  const { dismissNotificationKey } = useDismissedProviderUpdateNotificationKeys();
  const view = useProviderUpdateChipView();
  if (!hasLocalSecondary || view === null) return null;
  return {
    title: view.title,
    onOpen: () => void navigate({ to: "/settings/harnesses" }),
    onDismiss: () => dismissNotificationKey(view.notificationKey),
  };
}
