import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@workjet/contracts";

/**
 * Optionen einer Inline-Bestätigung. `confirmLabel` ersetzt „Bestätigen“ auf
 * der Primäraktion; die übrigen Felder kommen aus dem Desktop-Vertrag.
 */
export type InlineConfirmOptions = ConfirmDialogOptions & {
  readonly confirmLabel?: string;
};

type ConfirmationView = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly confirmLabel?: string;
};

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" } & ConfirmationView)
  | ({ readonly status: "closing" } & ConfirmationView);

type PendingConfirmation = ConfirmationView & {
  readonly resolve: (confirmed: boolean) => void;
};

function viewOf(confirmation: ConfirmationView): ConfirmationView {
  return {
    message: confirmation.message,
    variant: confirmation.variant,
    ...(confirmation.confirmLabel ? { confirmLabel: confirmation.confirmLabel } : {}),
  };
}

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that presents inline confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * Requests an inline confirmation when a host is mounted. An undefined result
 * means no host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: InlineConfirmOptions,
): Promise<boolean> | undefined {
  if (registeredHostCount === 0) return undefined;

  const confirmation = new Promise<boolean>((resolve) => {
    const pending: PendingConfirmation = {
      ...viewOf({
        message,
        variant: options?.variant ?? "default",
        ...(options?.confirmLabel ? { confirmLabel: options.confirmLabel } : {}),
      }),
      resolve,
    };
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({ status: "confirming", ...viewOf(pending) });
  });

  return confirmation;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({ status: "closing", ...viewOf(state) });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({ status: "confirming", ...viewOf(next) });
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
