import {
  WorkjetLlmRouteId,
  WorkjetNativeProviderResponse,
  type WorkjetLlmRoute,
  type WorkjetNativeProviderAccount,
  type WorkjetNativeProviderRegistry,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { newCommandId } from "./utils";
import {
  describeWorkjetProjectControlFailure,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "../workjetProjectControl";

export type NativeProviderInput =
  | { readonly action: "instance.providers.read" | "instance.providers.adopt" }
  | {
      readonly action: "instance.providers.observe";
      readonly accountId: string;
      readonly expectedAccountRevision: number;
    }
  | {
      readonly action: "instance.providers.models.select";
      readonly provider: string;
      readonly models: readonly string[];
      readonly expectedRevision: number;
    }
  | {
      readonly action: "instance.providers.models.exclude";
      readonly accountId: string;
      readonly expectedAccountRevision: number;
      readonly models: readonly string[];
      readonly expectedRevision: number;
    };
class NativeProviderFailure extends Error {}
const decode = Schema.decodeUnknownSync(WorkjetNativeProviderResponse);
export async function requestInstanceProviders(
  instanceId: string,
  input: NativeProviderInput,
  signal: AbortSignal,
  port?: WorkjetProjectControlPort,
): Promise<WorkjetNativeProviderRegistry> {
  signal.throwIfAborted();
  const operationId = newCommandId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      requestWorkjetProjectControl(instanceId, { ...input, version: 1, operationId }, port),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new NativeProviderFailure(
                "The instance did not respond in time. Refresh its accounts to read current state.",
              ),
            ),
          30_000,
        );
        onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal.throwIfAborted();
    if (result._tag !== "completed")
      throw new NativeProviderFailure(describeWorkjetProjectControlFailure(result, instanceId));
    const response = decode(result.response);
    if (response.action !== input.action || response.operationId !== operationId)
      throw new NativeProviderFailure(
        "The native account response belongs to another request. Refresh accounts.",
      );
    return response.registry;
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof NativeProviderFailure) throw error;
    throw new NativeProviderFailure(
      "Instance account control is unavailable. Check its connection, Owner/Admin access and installed CTOX version.",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
export function nativeAccountForRoute(
  route: WorkjetLlmRoute | undefined,
  accounts: readonly WorkjetNativeProviderAccount[],
): WorkjetNativeProviderAccount | undefined {
  const ref = route?.nativeAccountReference;
  return (
    ref &&
    accounts.find(
      (account) =>
        account.id === ref.accountId &&
        account.holder.id === ref.holderInstanceId &&
        account.revision === ref.accountRevision,
    )
  );
}
/** Native UUIDs never become Workjet-local gateway IDs. */
export function nativeLumaRoutes(
  routes: readonly WorkjetLlmRoute[],
  registry: WorkjetNativeProviderRegistry | undefined,
  instanceLabel: string,
): readonly WorkjetLlmRoute[] {
  if (!registry) return routes;
  const sameAccount = (route: WorkjetLlmRoute, account: WorkjetNativeProviderAccount) =>
    route.gatewayAccountId === undefined &&
    route.nativeAccountReference?.accountId === account.id &&
    route.nativeAccountReference.holderInstanceId === account.holder.id;
  const retained = routes.filter(
    (route) => !registry.accounts.some((account) => sameAccount(route, account)),
  );
  return [
    ...retained,
    ...registry.accounts.map((account) => {
      const previous = routes.find((route) => sameAccount(route, account));
      return {
        id: previous?.id ?? WorkjetLlmRouteId.make("native-account:" + account.id),
        label:
          previous?.label ??
          (account.provider === "claude" ? "Claude" : account.provider) +
            " · " +
            instanceLabel +
            " · " +
            account.id.slice(0, 8),
        nativeAccountReference: account.nativeAccountReference,
      };
    }),
  ];
}
export function requireNativeLumaModel(
  account: WorkjetNativeProviderAccount | undefined,
  model: string,
): void {
  if (!account || !account.enabled || !account.credentialReady)
    throw new Error("This instance account is unavailable. Refresh it in Settings → Models.");
  if (
    !account.modelCatalog.fresh ||
    !account.modelCatalog.lastAttempt?.success ||
    !account.modelCatalog.models.includes(model)
  )
    throw new Error("Choose a model from this account's current live list.");
  if (!account.effectiveModels.includes(model))
    throw new Error("Enable this model for the instance account in Settings → Models first.");
}
