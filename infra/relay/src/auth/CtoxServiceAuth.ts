import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";

function digest(value: string): Buffer {
  return NodeCrypto.createHash("sha256").update(value, "utf8").digest();
}

/** Compares fixed-size digests so missing/wrong credentials follow the same path. */
export function constantTimeServiceTokenMatches(input: {
  readonly authorization: string | undefined;
  readonly expected: string;
}): boolean {
  const match = /^Bearer ([^\s]+)$/u.exec(input.authorization ?? "");
  const supplied = match?.[1] ?? "";
  return (
    input.expected.length >= 32 &&
    NodeCrypto.timingSafeEqual(digest(supplied), digest(input.expected)) &&
    match !== null
  );
}

export class CtoxServiceAuth extends Context.Service<
  CtoxServiceAuth,
  {
    readonly isAuthorized: (authorization: string | undefined) => Effect.Effect<boolean>;
  }
>()("t3code-relay/auth/CtoxServiceAuth") {}

export const layer = Layer.effect(
  CtoxServiceAuth,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const configured = config.ctoxServiceToken;
    return CtoxServiceAuth.of({
      isAuthorized: (authorization) =>
        Effect.sync(() =>
          configured === undefined || Redacted.value(configured).length < 32
            ? false
            : constantTimeServiceTokenMatches({
                authorization,
                expected: Redacted.value(configured),
              }),
        ),
    });
  }),
);
