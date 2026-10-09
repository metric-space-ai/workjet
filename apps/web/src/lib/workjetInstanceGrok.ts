import { WorkjetInstanceGrokResponse } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { newCommandId } from "./utils";
import {
  describeWorkjetProjectControlFailure, requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "../workjetProjectControl";

class GrokControlFailure extends Error {}

export type InstanceGrokInput =
  | { readonly action: "instance.grok.read" | "instance.grok.start" | "instance.grok.remove" }
  | { readonly action: "instance.grok.poll" | "instance.grok.cancel"; readonly loginId: string }
  | { readonly action: "instance.grok.check"; readonly modelId: string };

/** Only the selected instance's authorized native control channel is used. */
export async function requestInstanceGrok(
  instanceId: string, input: InstanceGrokInput, signal: AbortSignal, port?: WorkjetProjectControlPort,
): Promise<WorkjetInstanceGrokResponse> {
  signal.throwIfAborted();
  const operationId = newCommandId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let timedOut = false;
  try {
    const pending = requestWorkjetProjectControl(instanceId, { ...input, version: 1, operationId }, port);
    // A retired start can still receive a public device receipt. Cancel that
    // exact native login instead of leaving an unseen authorization pending.
    void pending.then((late) => {
      if (input.action !== "instance.grok.start" || (!signal.aborted && !timedOut) || late._tag !== "completed") return;
      try {
        const response = Schema.decodeUnknownSync(WorkjetInstanceGrokResponse)(late.response);
        if (response.action !== input.action || response.operationId !== operationId || response.login?.phase !== "pending") return;
        const cleanup = new AbortController();
        void requestInstanceGrok(instanceId, { action: "instance.grok.cancel", loginId: response.login.loginId }, cleanup.signal, port).catch(() => {});
      } catch { /* A malformed or foreign receipt cannot authorize cancellation. */ }
    }).catch(() => {});
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new GrokControlFailure("The instance did not respond in time. Retry the action."));
        }, 30_000);
        onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal.throwIfAborted();
    if (result._tag !== "completed")
      throw new GrokControlFailure(describeWorkjetProjectControlFailure(result, instanceId));
    let response: WorkjetInstanceGrokResponse;
    try { response = Schema.decodeUnknownSync(WorkjetInstanceGrokResponse)(result.response); }
    catch { throw new GrokControlFailure("Update the connected CTOX instance to enable Grok Build sign-in."); }
    if (response.action !== input.action || response.operationId !== operationId)
      throw new GrokControlFailure("The Grok response belongs to another request. Retry the action.");
    if (input.action === "instance.grok.check" && response.check?.modelId !== input.modelId)
      throw new GrokControlFailure("The model check belongs to another model. Retry the check.");
    return response;
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof GrokControlFailure) throw error;
    throw new GrokControlFailure("Grok control failed. Check the instance connection and Owner/Admin access, then retry.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function grokVerificationLink(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}
