import type { CtoxAppApi } from "./ctoxClient";
import { CtoxCommandError, executeCtoxCommand } from "./commands";

/**
 * E25: V3 `sync.requestNative(method, params)` is a typed Core command of the same name in V4
 * (`api.command(method, params)`), answered by the command completion (§16.48). E26 acceptance
 * list with the V2 deadlines. Interactive streams (dictation, Jour-fixe speech) use the longer
 * deadline only for `open`.
 */
export const E25_METHODS = {
  "ctox.workjet.speech.dictation.v1": { deadlineMs: 5_000, openDeadlineMs: 20_000 },
  "ctox.workjet.speech.settings.v1": { deadlineMs: 25_000, checkTranscriptionDeadlineMs: 30_000 },
  "ctox.workjet.calendar.read.v1": { deadlineMs: 5_000 },
  "ctox.workjet.jour_fixe.speech.v1": { deadlineMs: 5_000, openDeadlineMs: 20_000 },
  "ctox.workjet.grok.v1": { deadlineMs: 24_000 },
  "ctox.workjet.device.v1": { deadlineMs: 10_000 },
} as const satisfies Record<
  string,
  { deadlineMs: number; openDeadlineMs?: number; checkTranscriptionDeadlineMs?: number }
>;
export type E25Method = keyof typeof E25_METHODS;

export function isE25Method(method: string): method is E25Method {
  return Object.prototype.hasOwnProperty.call(E25_METHODS, method);
}

export function e25DeadlineMs(method: E25Method, params: { readonly action?: unknown }): number {
  const spec: {
    deadlineMs: number;
    openDeadlineMs?: number;
    checkTranscriptionDeadlineMs?: number;
  } = E25_METHODS[method];
  if (params.action === "open" && spec.openDeadlineMs !== undefined) return spec.openDeadlineMs;
  if (params.action === "check.transcription" && spec.checkTranscriptionDeadlineMs !== undefined)
    return spec.checkTranscriptionDeadlineMs;
  return spec.deadlineMs;
}

/** Runs one E25 method on a V4 instance; the result is the command result value (E27.1). */
export async function requestCtoxNative(
  api: CtoxAppApi,
  method: E25Method,
  params: { readonly action?: unknown } & Record<string, unknown>,
  options?: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
): Promise<unknown> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    options?.deadlineMs ?? e25DeadlineMs(method, params),
  );
  const forward = () => deadline.abort();
  options?.signal?.addEventListener("abort", forward, { once: true });
  try {
    return await executeCtoxCommand(api, method, params, { signal: deadline.signal });
  } catch (error) {
    if (
      error instanceof CtoxCommandError &&
      error.code === "aborted" &&
      options?.signal?.aborted !== true
    )
      throw new CtoxCommandError("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", forward);
  }
}
