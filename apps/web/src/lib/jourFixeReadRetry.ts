import type { WorkjetProjectControlFailure } from "../workjetProjectControl";

export const JOUR_FIXE_READ_DEADLINE_MS = 5 * 60_000;

/** Machine-readable transport failures; the room owns their visible wording. */
export class JourFixeReadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JourFixeReadError";
  }
}

export function jourFixeTransportError(failure: WorkjetProjectControlFailure) {
  return new JourFixeReadError(
    failure.error?.code ??
      (failure.diagnostic?.reason === "request_timeout" ? "request_timeout" : failure.code),
  );
}

const aborted = () => new DOMException("aborted", "AbortError");

export function jourFixeReadDeadline() {
  return Date.now() + JOUR_FIXE_READ_DEADLINE_MS;
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal | undefined, deadline: number) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => finish(() => reject(aborted()));
    const timer = setTimeout(
      () => finish(() => reject(new JourFixeReadError("timeout"))),
      Math.max(0, deadline - Date.now()),
    );
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settle();
    };
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) abort();
  });
}

/** Serial retries share the original deadline, including each request and each delay. */
export async function retryJourFixeRead<T>(
  read: () => Promise<T>,
  options: { readonly signal?: AbortSignal | undefined; readonly deadline?: number } = {},
): Promise<T> {
  const deadline = options.deadline ?? jourFixeReadDeadline();
  let failures = 0;
  while (true) {
    if (options.signal?.aborted) throw aborted();
    if (Date.now() >= deadline) throw new JourFixeReadError("timeout");
    try {
      return await bounded(read(), options.signal, deadline);
    } catch (error) {
      if (
        !(error instanceof JourFixeReadError) ||
        !["timeout", "request_timeout", "guest_failed"].includes(error.code) ||
        Date.now() >= deadline
      )
        throw error;
      const delay = [5_000, 10_000, 20_000][failures++] ?? 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await bounded(
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, delay);
          }),
          options.signal,
          deadline,
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }
}
