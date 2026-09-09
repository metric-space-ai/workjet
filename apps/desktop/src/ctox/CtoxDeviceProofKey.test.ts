import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import {
  createCtoxDeviceProofKey,
  restoreCtoxDeviceProofKey,
  CtoxDeviceProofKeyError,
} from "./CtoxDeviceProofKey.ts";

const nonce = NodeCrypto.randomBytes(32).toString("base64url");

describe("Main device proof key", () => {
  it("produces the native P-256 P1363 nonce proof and RFC 7638 thumbprint", () => {
    const key = createCtoxDeviceProofKey();
    const proof = key.signNonce(nonce);
    const publicKey = NodeCrypto.createPublicKey({ key: key.publicJwk, format: "jwk" });
    expect(NodeBuffer.Buffer.from(proof.signature, "base64url")).toHaveLength(64);
    expect(
      NodeCrypto.verify(
        "sha256",
        NodeBuffer.Buffer.from(nonce, "utf8"),
        {
          key: publicKey,
          dsaEncoding: "ieee-p1363",
        },
        NodeBuffer.Buffer.from(proof.signature, "base64url"),
      ),
    ).toBe(true);
    expect(
      NodeCrypto.verify(
        "sha256",
        NodeBuffer.Buffer.from("x".repeat(43), "utf8"),
        {
          key: publicKey,
          dsaEncoding: "ieee-p1363",
        },
        NodeBuffer.Buffer.from(proof.signature, "base64url"),
      ),
    ).toBe(false);
    const canonical = `{"crv":"P-256","kty":"EC","x":"${proof.publicX}","y":"${proof.publicY}"}`;
    expect(key.thumbprint).toBe(
      NodeCrypto.createHash("sha256").update(canonical).digest("base64url"),
    );
    expect(key.publicJwk).not.toHaveProperty("d");
  });

  it("restores the same identity while redacting its storage export", () => {
    const key = createCtoxDeviceProofKey();
    const material = key.exportForStorage();
    const restored = restoreCtoxDeviceProofKey(material);
    expect(restored.publicJwk).toEqual(key.publicJwk);
    expect(restored.thumbprint).toBe(key.thumbprint);
    expect(String(material)).not.toContain(Redacted.value(material));
    expect(Object.isFrozen(restored.publicJwk)).toBe(true);
    const proof = restored.signNonce(nonce);
    expect(
      NodeCrypto.verify(
        "sha256",
        NodeBuffer.Buffer.from(nonce),
        {
          key: NodeCrypto.createPublicKey({ key: key.publicJwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        NodeBuffer.Buffer.from(proof.signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("rejects malformed challenges before signing", () => {
    const key = createCtoxDeviceProofKey();
    for (const bad of ["", "x".repeat(42), "x".repeat(44), "/".repeat(43), `${nonce}\n`]) {
      expect(() => key.signNonce(bad)).toThrow(CtoxDeviceProofKeyError);
    }
  });

  it("rejects corrupt, noncanonical and wrong-curve key material without rotating", () => {
    const wrongCurve = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "secp384r1" })
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64");
    for (const bad of [
      "",
      "not a key",
      "a".repeat(4097),
      wrongCurve,
      `${Redacted.value(createCtoxDeviceProofKey().exportForStorage())}\n`,
    ]) {
      expect(() => restoreCtoxDeviceProofKey(Redacted.make(bad))).toThrow(
        "The device proof key or challenge is invalid.",
      );
    }
  });
});
