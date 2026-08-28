import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { publicKeyKid, signAssertion, toJwk } from "./ControlIdentityAssertions.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

describe("Relay control identity assertions", () => {
  it.effect("signs a short ctox.dev assertion with the advertised key id", () =>
    Effect.gen(function* () {
      const assertion = signAssertion({
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        claims: {
          iss: "https://relay.example.test",
          aud: "ctox.dev",
          sub: "user-1",
          jti: "assertion-1",
          iat: 100,
          exp: 400,
          workjetInstallationId: "desktop-1",
          businessOsInstanceId: "business-os-1",
          cnf: { jkt: "p".repeat(43) },
        },
      });
      const header = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ kid: Schema.String })),
      )(Buffer.from(assertion.split(".")[0]!, "base64url").toString("utf8"));
      expect(header.kid).toBe(publicKeyKid(keyPair.publicKey));
      expect(toJwk(keyPair.publicKey)).toMatchObject({
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        kid: header.kid,
      });
      expect(
        yield* verifyRelayJwt({
          publicKey: keyPair.publicKey,
          token: assertion,
          typ: "workjet-relay-control-identity+jwt",
          issuer: "https://relay.example.test",
          audience: "ctox.dev",
          nowEpochSeconds: 200,
          maxTokenAge: "5 minutes",
        }),
      ).toMatchObject({
        sub: "user-1",
        workjetInstallationId: "desktop-1",
        businessOsInstanceId: "business-os-1",
        cnf: { jkt: "p".repeat(43) },
      });
    }),
  );
});
