import type { DesktopPendingDeepLink } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/**
 * Explicit confirmation for an OS-delivered deep link (docs/workjet-plan.md
 * Wave 7).
 *
 * A `ctox-desktop://` link can be triggered by any web page or document on the
 * machine, so the main process never acts on one: `DesktopDeepLinkRouter`
 * parses and queues it, and this dialog is the only thing that can turn it
 * into a navigation. Links clicked *inside* the app are a different case and
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

export function DeepLinkConfirmationDialog({
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
  );
}

/**
 * Presentational half: shows the canonical target and nothing else. It never
 * navigates on its own — the caller's `onConfirm` does.
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogPopup className="max-w-md" data-deep-link-confirmation-dialog showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Open this link in CTOX Desktop App?</DialogTitle>
          <DialogDescription>
            A <code>{link.scheme}</code> link was opened from outside the app. Nothing happens
            unless you choose Open.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <p
            className="max-h-24 overflow-y-auto break-all font-mono text-sm text-foreground"
            data-deep-link-target
          >
            {link.canonicalUrl}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button data-deep-link-dismiss type="button" variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button data-deep-link-confirm type="button" onClick={onConfirm}>
            Open
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
