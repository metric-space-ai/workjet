// Generated from the adjacent exact ctox-dev source fixture, commit 7e758a20ad9ed31c4e291f999fd37b9246d44f14.
// Types stripped; constructor parameter properties expanded. Verifier logic unchanged.
import * as NodeCrypto from "node:crypto";

export class DeviceKeyError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function canonicalBase64Url(value, bytes) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").length === bytes &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

export function normalizeDevicePublicJwk(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DeviceKeyError("DEVICE_KEY_INVALID", 400);
  }
  const jwk = input;
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    "d" in jwk ||
    (jwk.alg !== undefined && jwk.alg !== "ES256") ||
    (jwk.use !== undefined && jwk.use !== "sig") ||
    (jwk.key_ops !== undefined &&
      (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify")) ||
    !canonicalBase64Url(jwk.x, 32) ||
    !canonicalBase64Url(jwk.y, 32)
  ) {
    throw new DeviceKeyError("DEVICE_KEY_INVALID", 400);
  }
  // RFC 7638: required public members only, in lexicographic order.
  const publicJwk = { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y };
  try {
    const key = NodeCrypto.createPublicKey({ key: publicJwk, format: "jwk" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("wrong curve");
    }
  } catch {
    throw new DeviceKeyError("DEVICE_KEY_INVALID", 400);
  }
  return publicJwk;
}

export function deviceKeyThumbprint(jwk) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(normalizeDevicePublicJwk(jwk)))
    .digest("base64url");
}

export function deviceProofPayload(nonce, method, host, path, body) {
  const bodyHash = NodeCrypto.createHash("sha256").update(body).digest("hex");
  return `${nonce}|${method.toUpperCase()}|${host}|${path}|${bodyHash}`;
}

export function verifyDeviceProof(jwk, signature, payload) {
  if (!canonicalBase64Url(signature, 64)) return false;
  try {
    return NodeCrypto.verify(
      "sha256",
      Buffer.from(payload, "utf8"),
      {
        key: NodeCrypto.createPublicKey({ key: jwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function validDeviceThumbprint(value) {
  return canonicalBase64Url(value, 32);
}

export function validDeviceNonce(value) {
  return canonicalBase64Url(value, 32);
}

export function hasDeviceProof(request) {
  return ["x-ctox-device-thumbprint", "x-ctox-device-nonce", "x-ctox-device-signature"].some(
    (header) => request.headers.has(header),
  );
}

// Hash the original bytes. Never stringify parsed JSON for signature checks.
export async function readDeviceRequestBody(request, maximumBytes = 8192) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new DeviceKeyError("DEVICE_REQUEST_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

export function parseDeviceJson(body) {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* Return one public input error. */
  }
  throw new DeviceKeyError("DEVICE_REQUEST_INVALID", 400);
}
