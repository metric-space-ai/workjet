import type { DesktopPendingDeepLink } from "@workjet/contracts";
import { useEffect, useState } from "react";

import { InlineConfirmBar, InlineNoticePortal } from "../InlineNoticeSlot";

/**
 * Explicit confirmation for an OS-delivered deep link (docs/workjet-plan.md
 * Wave 7).
 *
 * A `ctox-desktop://` link can be triggered by any web page or document on the
 * machine, so the main process never acts on one: `DesktopDeepLinkRouter`
 * parses and queues it, and this inline bar under the header (no modal) is
 * the only thing that can turn it into a navigation. Links clicked *inside* the app are a different case and
 * do not appear here — those are redirected in place by the `will-navigate`
 * handler in DesktopWindow, because the user's click already was the consent.
 *
 * Delivery: the main process pushes a payload-free "links are waiting" signal
 * and this component drains the queue over IPC, so a link is delivered exactly
 * once no matter how the signal and the mount-time drain interleave. Several
 * links queue FIFO and are confirmed one at a time.
 */

const navigateWithLocation = (url: string): void => {
  window.location.assign(url);
};

export function DeepLinkConfirmationNotice({
  navigate = navigateWithLocation,
}: {
  readonly navigate?: (url: string) => void;
} = {}) {
  const [queue, setQueue] = useState<readonly DesktopPendingDeepLink[]>([]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    const takePendingDeepLinks = bridge?.takePendingDeepLinks;
    if (!takePendingDeepLinks) return;

    let cancelled = false;
    const drain = () => {
      void takePendingDeepLinks
        .call(bridge)
        .then((links) => {
          if (cancelled || links.length === 0) return;
          setQueue((current) => [...current, ...links]);
        })
        .catch(() => undefined);
    };

    // Subscribe before the first drain: a link that arrives in between then
    // still raises the signal instead of waiting for the next one.
    const unsubscribe = bridge?.onDeepLinkPending?.(drain);
    drain();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const current = queue[0] ?? null;
  if (!current) return null;

  const resolve = (linkId: string) => {
    setQueue((currentQueue) =>
      currentQueue[0]?.linkId === linkId ? currentQueue.slice(1) : currentQueue,
    );
  };

  return (
    <InlineNoticePortal>
      <DeepLinkConfirmationPrompt
        key={current.linkId}
        link={current}
        onConfirm={() => {
          resolve(current.linkId);
          navigate(current.canonicalUrl);
        }}
        onDismiss={() => {
          resolve(current.linkId);
        }}
      />
    </InlineNoticePortal>
  );
}

/**
 * Das Ziel eines Links als Ort, nie als rohe URL (UI-Vertrag §2):
 * Einstellungen, Pull Requests, neue Unterhaltung, Unterhaltung, Projekte.
 */
export function describeDeepLinkTarget(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [first] = segments;
  if (!first) return "Projekte";
  if (first === "settings") return "Einstellungen";
  if (first === "pull-requests") return "Pull Requests";
  if (first === "draft") return "Neue Unterhaltung";
  if (segments.length >= 2) return "Unterhaltung";
  return "Workjet";
}

/**
 * Presentational half: an inline bar under the header (no modal) with the
 * target place and nothing else. It never navigates on its own — the
 * caller's `onConfirm` does.
 */
export function DeepLinkConfirmationPrompt({
  link,
  onConfirm,
  onDismiss,
}: {
  readonly link: DesktopPendingDeepLink;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <InlineConfirmBar
      confirmLabel="Öffnen"
      markers={{
        row: "deep-link-confirmation",
        target: "deep-link-target",
        confirm: "deep-link-confirm",
        cancel: "deep-link-dismiss",
      }}
      question="Externen Link öffnen?"
      target={describeDeepLinkTarget(link.path)}
      onCancel={onDismiss}
      onConfirm={onConfirm}
    />
  );
}
