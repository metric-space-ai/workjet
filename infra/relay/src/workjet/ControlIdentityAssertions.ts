import * as NodeCrypto from "node:crypto";

import { normalizeRelayIssuer, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { and, eq, gt, isNull } from "drizzle-orm";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { relayWorkjetControlIdentityAssertions } from "../persistence/schema.ts";

const ASSERTION_TYP = "workjet-relay-control-identity+jwt";
const ASSERTION_AUDIENCE = "ctox.dev";
const ASSERTION_TTL = { minutes: 5 } as const;

const AssertionClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Literal(ASSERTION_AUDIENCE),
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  workjetInstallationId: Schema.String,
  businessOsInstanceId: Schema.String,
  cnf: Schema.Struct({ jkt: Schema.String }),
});
export type AssertionClaims = typeof AssertionClaims.Type;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function publicKeyKid(publicKey: string): string {
  const der = NodeCrypto.createPublicKey(publicKey.replace(/\\n/gu, "\n")).export({
    format: "der",
    type: "spki",
  });
  return NodeCrypto.createHash("sha256").update(der).digest("base64url");
}

export function signAssertion(input: {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly claims: AssertionClaims;
}): string {
  const header = base64UrlJson({
    alg: "EdDSA",
    typ: ASSERTION_TYP,
    kid: publicKeyKid(input.publicKey),
  });
  const payload = base64UrlJson(input.claims);
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign(
    null,
    Buffer.from(signingInput, "ascii"),
    input.privateKey.replace(/\\n/gu, "\n"),
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

export interface RelayJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly use: "sig";
  readonly alg: "EdDSA";
  readonly kid: string;
}

export function toJwk(publicKey: string): RelayJwk {
  const normalized = publicKey.replace(/\\n/gu, "\n");
  const exported = NodeCrypto.createPublicKey(normalized).export({ format: "jwk" });
  if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || typeof exported.x !== "string") {
    throw new Error("Relay cloud mint public key is not Ed25519.");
  }
  return {
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    use: "sig",
    alg: "EdDSA",
    kid: publicKeyKid(normalized),
  };
}

export class ControlIdentityAssertionError extends Schema.TaggedErrorClass<ControlIdentityAssertionError>()(
  "ControlIdentityAssertionError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class ControlIdentityAssertions extends Context.Service<
  ControlIdentityAssertions,
  {
    readonly issue: (input: {
      readonly relayUserId: string;
      readonly proofKeyThumbprint: string;
      readonly workjetInstallationId: string;
      readonly businessOsInstanceId: string;
    }) => Effect.Effect<
      { readonly assertion: string; readonly expiresAt: string },
      ControlIdentityAssertionError
    >;
    readonly consume: (
      assertion: string,
    ) => Effect.Effect<AssertionClaims | null, ControlIdentityAssertionError>;
    readonly jwks: Effect.Effect<
      { readonly keys: ReadonlyArray<RelayJwk> },
      ControlIdentityAssertionError
    >;
  }
>()("t3code-relay/workjet/ControlIdentityAssertions") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const db = yield* RelayDb.RelayDb;
  const issuer = normalizeRelayIssuer(config.relayIssuer);

  const jwks = Effect.try({
    try: () => ({
      keys: [config.cloudMintPublicKey, ...(config.cloudMintPreviousPublicKeys ?? [])].map(toJwk),
    }),
    catch: (cause) => new ControlIdentityAssertionError({ operation: "jwks", cause }),
  });

  const issue: ControlIdentityAssertions["Service"]["issue"] = Effect.fn(
    "relay.workjet.control_identity.issue",
  )(function* (input) {
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, ASSERTION_TTL);
    const claims: AssertionClaims = {
      iss: issuer,
      aud: ASSERTION_AUDIENCE,
      sub: input.relayUserId,
      jti: NodeCrypto.randomBytes(32).toString("base64url"),
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      workjetInstallationId: input.workjetInstallationId,
      businessOsInstanceId: input.businessOsInstanceId,
      cnf: { jkt: input.proofKeyThumbprint },
    };
    const assertion = yield* Effect.try({
      try: () =>
        signAssertion({
          privateKey: Redacted.value(config.cloudMintPrivateKey),
          publicKey: config.cloudMintPublicKey,
          claims,
        }),
      catch: (cause) => new ControlIdentityAssertionError({ operation: "sign", cause }),
    });
    const nowIso = DateTime.formatIso(now);
    yield* db
      .insert(relayWorkjetControlIdentityAssertions)
      .values({
        jti: claims.jti,
        relayUserId: claims.sub,
        workjetInstallationId: claims.workjetInstallationId,
        businessOsInstanceId: claims.businessOsInstanceId,
        proofKeyThumbprint: claims.cnf.jkt,
        expiresAt: DateTime.formatIso(expiresAt),
        consumedAt: null,
        createdAt: nowIso,
      })
      .pipe(
        Effect.mapError(
          (cause) => new ControlIdentityAssertionError({ operation: "persist", cause }),
        ),
      );
    return { assertion, expiresAt: DateTime.formatIso(expiresAt) };
  });

  const consume: ControlIdentityAssertions["Service"]["consume"] = Effect.fn(
    "relay.workjet.control_identity.consume",
  )(function* (assertion) {
    const now = yield* DateTime.now;
    const nowEpochSeconds = Math.floor(now.epochMilliseconds / 1_000);
    let claims: AssertionClaims | null = null;
    for (const publicKey of [
      config.cloudMintPublicKey,
      ...(config.cloudMintPreviousPublicKeys ?? []),
    ]) {
      const verified = yield* verifyRelayJwt({
        publicKey,
        token: assertion,
        typ: ASSERTION_TYP,
        issuer,
        audience: ASSERTION_AUDIENCE,
        nowEpochSeconds,
        maxTokenAge: "5 minutes",
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AssertionClaims)), Effect.option);
      if (verified._tag === "Some") {
        claims = verified.value;
        break;
      }
    }
    if (!claims) return null;
    const nowIso = DateTime.formatIso(now);
    const consumed = yield* db
      .update(relayWorkjetControlIdentityAssertions)
      .set({ consumedAt: nowIso })
      .where(
        and(
          eq(relayWorkjetControlIdentityAssertions.jti, claims.jti),
          eq(relayWorkjetControlIdentityAssertions.relayUserId, claims.sub),
          eq(
            relayWorkjetControlIdentityAssertions.workjetInstallationId,
            claims.workjetInstallationId,
          ),
          eq(
            relayWorkjetControlIdentityAssertions.businessOsInstanceId,
            claims.businessOsInstanceId,
          ),
          eq(relayWorkjetControlIdentityAssertions.proofKeyThumbprint, claims.cnf.jkt),
          isNull(relayWorkjetControlIdentityAssertions.consumedAt),
          gt(relayWorkjetControlIdentityAssertions.expiresAt, nowIso),
        ),
      )
      .returning({ jti: relayWorkjetControlIdentityAssertions.jti })
      .pipe(
        Effect.mapError(
          (cause) => new ControlIdentityAssertionError({ operation: "consume", cause }),
        ),
      );
    return consumed.length === 1 ? claims : null;
  });

  return ControlIdentityAssertions.of({ issue, consume, jwks });
});

export const layer = Layer.effect(ControlIdentityAssertions, make);
