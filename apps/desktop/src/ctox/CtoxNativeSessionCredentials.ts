// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  NativeBusinessDataCredentialChallengeSchema,
  type NativeBusinessDataCredentialReply,
} from "@workjet/contracts/ctoxBusinessData";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { AccountLifecycle } from "./CtoxAccountLifecycle.ts";
import type { CtoxInstanceRegistry, CtoxDeviceKeyScope } from "./CtoxInstanceRegistry.ts";
import type { CtoxDeviceProofKey } from "./CtoxDeviceProofKey.ts";

/** Main-local value for the native callback, not a renderer or wire contract. */
export interface CtoxNativeCredentials {
  readonly capabilityToken: Redacted.Redacted<string>;
  readonly deviceProof: ReturnType<CtoxDeviceProofKey["signNonce"]> | undefined;
}

export class CtoxNativeCredentialsError extends Error {
  constructor() {
    super("The native session credentials are no longer available.");
    this.name = "CtoxNativeCredentialsError";
  }
}

/**
 * Own one connection's deferred credential callback. The native adapter must
 * invoke it only after NativeSessionTarget verifies the current channel.
 * This owner never confirms an account or turns transport-ready into data-ready.
 */
export function createCtoxNativeCredentialLease(input: {
  readonly account: AccountLifecycle;
  readonly registry: Pick<CtoxInstanceRegistry["Service"], "deviceProofKey">;
  readonly scope: CtoxDeviceKeyScope;
  readonly sessionEpoch: number;
  readonly capabilityToken: Redacted.Redacted<string>;
  readonly expiresAtMs: number;
  readonly expectedThumbprint?: string;
  /** Explicit first enrollment; a reconnect must not replace missing identity. */
  readonly createKeyIfMissing: boolean;
  /** Host-owned check of the proven target and current native connection. */
  readonly targetIsCurrent: () => boolean;
  readonly now?: () => number;
}) {
  input = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
  const cancellation = new AbortController();
  const pending = new Set<Promise<CtoxNativeCredentials>>();
  const now = input.now ?? Date.now;
  let unregister: (() => void) | undefined;
  const close = async () => {
    cancellation.abort();
    unregister?.();
    unregister = undefined;
    await Promise.allSettled(pending);
  };
  const check = () => {
    if (
      cancellation.signal.aborted ||
      input.account.sessionEpoch() !== input.sessionEpoch ||
      !Number.isFinite(input.expiresAtMs) ||
      now() >= input.expiresAtMs ||
      !input.targetIsCurrent()
    )
      throw new CtoxNativeCredentialsError();
  };
  // Register synchronously so an in-progress account transition cannot be missed.
  unregister = input.account.registerInvalidator(close);
  return {
    close,
    provide: (nonce: string | undefined): Promise<CtoxNativeCredentials> => {
      if (
        pending.size >= 2 ||
        (nonce !== undefined && (nonce.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(nonce)))
      ) {
        return Promise.reject(new CtoxNativeCredentialsError());
      }
      const operation = Effect.gen(function* () {
        yield* Effect.sync(check);
        if (!Redacted.value(input.capabilityToken).trim()) {
          return yield* Effect.fail(new CtoxNativeCredentialsError());
        }
        if (nonce === undefined) {
          return { capabilityToken: input.capabilityToken, deviceProof: undefined };
        }
        const key = yield* input.registry.deviceProofKey(
          input.scope,
          input.createKeyIfMissing && input.expectedThumbprint === undefined,
        );
        yield* Effect.sync(check);
        if (input.expectedThumbprint !== undefined && key.thumbprint !== input.expectedThumbprint) {
          return yield* Effect.fail(new CtoxNativeCredentialsError());
        }
        const deviceProof = key.signNonce(nonce);
        yield* Effect.sync(check);
        return { capabilityToken: input.capabilityToken, deviceProof };
      });
      const result = Effect.runPromise(operation.pipe(Effect.timeout(20_000)), {
        signal: cancellation.signal,
      })
        .then((credentials) => {
          check();
          return credentials;
        })
        .catch(() => {
          throw new CtoxNativeCredentialsError();
        });
      pending.add(result);
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      );
      return result;
    },
  };
}

const decodeCredentialChallenge = Schema.decodeUnknownSync(
  NativeBusinessDataCredentialChallengeSchema,
  { onExcessProperty: "error" },
);
const validCallbackId = (value: string) =>
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && (code < 127 || code > 159);
  });

/** Generated private-IPC callback for one host-owned connection; never Renderer IPC. */
export function bindCtoxNativeCredentialCallback(
  lease: ReturnType<typeof createCtoxNativeCredentialLease>,
  binding: {
    readonly targetId: string;
    readonly connectionId: string;
    readonly sessionEpoch: number;
  },
) {
  const bound = Object.freeze({ ...binding });
  if (
    !validCallbackId(bound.targetId) ||
    !validCallbackId(bound.connectionId) ||
    !Number.isSafeInteger(bound.sessionEpoch) ||
    bound.sessionEpoch < 0
  )
    throw new CtoxNativeCredentialsError();
  return async (input: unknown): Promise<NativeBusinessDataCredentialReply> => {
    try {
      const request = decodeCredentialChallenge(input);
      if (
        request.version !== 1 ||
        !validCallbackId(request.requestId) ||
        request.connectionId !== bound.connectionId ||
        request.targetId !== bound.targetId ||
        request.sessionEpoch !== bound.sessionEpoch
      )
        throw new CtoxNativeCredentialsError();
      const credentials = await lease.provide(request.nonce ?? undefined);
      return {
        version: 1,
        requestId: request.requestId,
        connectionId: bound.connectionId,
        sessionEpoch: bound.sessionEpoch,
        capabilityToken: Redacted.value(credentials.capabilityToken),
        ...(credentials.deviceProof === undefined ? {} : { deviceProof: credentials.deviceProof }),
      };
    } catch {
      throw new CtoxNativeCredentialsError();
    }
  };
}
