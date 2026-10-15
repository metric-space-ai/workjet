import { WorkjetInstanceGrokResponse } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { newCommandId } from "./utils";
import {
  WorkjetProjectControlError,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "../workjetProjectControl";

class GrokControlFailure extends Error {}

export type InstanceGrokInput =
  | { readonly action: "instance.grok.read" | "instance.grok.start" | "instance.grok.remove" }
  | { readonly action: "instance.grok.poll" | "instance.grok.cancel"; readonly loginId: string }
  | { readonly action: "instance.grok.check"; readonly modelId: string };

/** Only the selected instance's authorized native control channel is used. */
export async function requestInstanceGrok(
  instanceId: string,
  input: InstanceGrokInput,
  signal: AbortSignal,
  port?: WorkjetProjectControlPort,
): Promise<WorkjetInstanceGrokResponse> {
  signal.throwIfAborted();
  const operationId = newCommandId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let timedOut = false;
  try {
    const pending = requestWorkjetProjectControl(
      instanceId,
      { ...input, version: 1, operationId },
      port,
    );
    // A retired start can still receive a public device receipt. Cancel that
    // exact native login instead of leaving an unseen authorization pending.
    void pending
      .then((late) => {
        if (
          input.action !== "instance.grok.start" ||
          (!signal.aborted && !timedOut) ||
          late._tag !== "completed"
        )
          return;
        try {
          const response = Schema.decodeUnknownSync(WorkjetInstanceGrokResponse)(late.response);
          if (
            response.action !== input.action ||
            response.operationId !== operationId ||
            response.login?.phase !== "pending"
          )
            return;
          const cleanup = new AbortController();
          void requestInstanceGrok(
            instanceId,
            { action: "instance.grok.cancel", loginId: response.login.loginId },
            cleanup.signal,
            port,
          ).catch(() => {});
        } catch {
          /* A malformed or foreign receipt cannot authorize cancellation. */
        }
      })
      .catch(() => {});
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
    if (result._tag !== "completed") throw new WorkjetProjectControlError(result, instanceId);
    let response: WorkjetInstanceGrokResponse;
    try {
      response = Schema.decodeUnknownSync(WorkjetInstanceGrokResponse)(result.response);
    } catch {
      throw new GrokControlFailure(
        "Update the connected CTOX instance to enable Grok Build sign-in.",
      );
    }
    if (response.action !== input.action || response.operationId !== operationId)
      throw new GrokControlFailure(
        "The Grok response belongs to another request. Retry the action.",
      );
    if (input.action === "instance.grok.check" && response.check?.modelId !== input.modelId)
      throw new GrokControlFailure("The model check belongs to another model. Retry the check.");
    return response;
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof GrokControlFailure || error instanceof WorkjetProjectControlError)
      throw error;
    throw new GrokControlFailure(
      "Grok control failed. Check the instance connection and Owner/Admin access, then retry.",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

type GrokFailure = Pick<
  NonNullable<WorkjetInstanceGrokResponse["check"]>,
  "errorCode" | "upstream"
>;

const localRemedies: Readonly<Record<NonNullable<GrokFailure["errorCode"]>, string>> = {
  timeout: "The model did not answer within 20 seconds. Retry the check.",
  missing_credential: "Sign in with your Grok Build subscription.",
  model_unavailable: "This model is absent from the account's live catalog. Refresh the models.",
  invalid_response: "The gateway returned no usable answer. Retry the check.",
  request_failed:
    "The gateway request failed. Retry; a failed request does not prove an expired login.",
};

/** Upstream diagnoses require the instance's redacted, typed HTTP receipt. */
export function describeInstanceGrokFailure(failure: GrokFailure): string {
  const upstream = failure.upstream;
  if (!upstream)
    return failure.errorCode
      ? localRemedies[failure.errorCode]
      : "The check failed. Retry the check.";
  const receipt = `HTTP ${upstream.status} · ${upstream.stage}`;
  switch (upstream.status) {
    case 401:
      return `The provider rejected the subscription credential (${receipt}). Remove this account with the trash can, confirm, then choose Grok Build OAuth to sign in again.`;
    case 403:
      return `The provider denied access (${receipt}). Check your Grok Build subscription permissions, then retry.`;
    case 404:
      return upstream.stage === "inference"
        ? `The provider could not find this model (${receipt}). Refresh models and check a model from the live list.`
        : `The provider's model catalog was not found (${receipt}). Update the connected CTOX instance, then refresh models.`;
    case 426:
      return `The provider requires a newer Grok client (${receipt}). Update the connected CTOX instance, then retry.`;
    case 429:
      return `The provider rate limited this request (${receipt}). Retry later.`;
    default:
      return `The provider request failed (${receipt}). Retry the check.`;
  }
}

export function grokVerificationLink(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
