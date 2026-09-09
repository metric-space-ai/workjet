// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const PublicJwk = Schema.Struct({
  crv: Schema.Literal("P-256"),
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
});
const encodeThumbprintInput = Schema.encodeUnknownSync(Schema.fromJsonString(PublicJwk));
const base64url32 = /^[A-Za-z0-9_-]{43}$/;

export class CtoxDeviceProofKeyError extends Error {
  constructor() {
    super("The device proof key or challenge is invalid.");
    this.name = "CtoxDeviceProofKeyError";
  }
}

/** Main-only key adapter. Authorization/enrollment belong to its host owner. */
export interface CtoxDeviceProofKey {
  readonly publicJwk: Readonly<typeof PublicJwk.Type>;
  readonly thumbprint: string;
  /** Only unwrap at the existing encrypted Secret-Store boundary. */
  readonly exportForStorage: () => Redacted.Redacted<string>;
  /** Invoke only after native target proof and current account-epoch checks. */
  readonly signNonce: (nonce: string) => {
    readonly publicX: string;
    readonly publicY: string;
    readonly signature: string;
  };
}

function wrapKey(key: NodeCrypto.KeyObject): CtoxDeviceProofKey {
  if (key.type !== "private" || key.asymmetricKeyType !== "ec") {
    throw new CtoxDeviceProofKeyError();
  }
  const exported = NodeCrypto.createPublicKey(key).export({ format: "jwk" });
  if (
    exported.kty !== "EC" ||
    exported.crv !== "P-256" ||
    typeof exported.x !== "string" ||
    typeof exported.y !== "string" ||
    !base64url32.test(exported.x) ||
    !base64url32.test(exported.y)
  )
    throw new CtoxDeviceProofKeyError();
  // RFC 7638 member ordering, matching the existing native CTOX verifier.
  const publicJwk = Object.freeze({
    crv: "P-256" as const,
    kty: "EC" as const,
    x: exported.x,
    y: exported.y,
  });
  const thumbprint = NodeCrypto.createHash("sha256")
    .update(encodeThumbprintInput(publicJwk))
    .digest("base64url");
  return Object.freeze({
    publicJwk,
    thumbprint,
    exportForStorage: () =>
      Redacted.make(key.export({ format: "der", type: "pkcs8" }).toString("base64")),
    signNonce: (nonce: string) => {
      if (nonce.length !== 43 || !base64url32.test(nonce)) throw new CtoxDeviceProofKeyError();
      try {
        const signature = NodeCrypto.sign("sha256", NodeBuffer.Buffer.from(nonce, "utf8"), {
          key,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url");
        return { publicX: publicJwk.x, publicY: publicJwk.y, signature };
      } catch {
        throw new CtoxDeviceProofKeyError();
      }
    },
  });
}

export function createCtoxDeviceProofKey(): CtoxDeviceProofKey {
  try {
    return wrapKey(NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
  } catch {
    throw new CtoxDeviceProofKeyError();
  }
}

/** Restore the same identity. Invalid material never silently creates a new key. */
export function restoreCtoxDeviceProofKey(encoded: Redacted.Redacted<string>): CtoxDeviceProofKey {
  try {
    const value = Redacted.value(encoded);
    if (value.length === 0 || value.length > 4096) throw new CtoxDeviceProofKeyError();
    const der = NodeBuffer.Buffer.from(value, "base64");
    if (der.toString("base64") !== value) throw new CtoxDeviceProofKeyError();
    return wrapKey(NodeCrypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  } catch {
    throw new CtoxDeviceProofKeyError();
  }
}
