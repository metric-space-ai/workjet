import type {
  CtoxMobileShellPackDistributionV1,
  CtoxMobileShellPackResolveInput,
  CtoxMobileShellPackResolveResult,
  CtoxMobileShellPackTrustKey,
} from "@t3tools/contracts";
import { hexToBytes } from "@noble/hashes/utils.js";

export interface BusinessOsShellPackResolvePort {
  readonly resolve: (
    input: CtoxMobileShellPackResolveInput,
  ) => Promise<CtoxMobileShellPackResolveResult>;
}

export interface TrustedBusinessOsShellPackDistribution {
  readonly descriptor: CtoxMobileShellPackDistributionV1;
  readonly publicKeys: ReadonlyMap<string, Uint8Array>;
}

export class BusinessOsShellDistributionError extends Error {
  constructor(
    readonly code:
      | "descriptor"
      | "artifact"
      | "artifact-expired"
      | "compatibility"
      | "trust-unavailable"
      | "trust-map"
      | "untrusted-key",
    message: string,
  ) {
    super(message);
    this.name = "BusinessOsShellDistributionError";
  }
}

function fail(code: BusinessOsShellDistributionError["code"], message: string): never {
  throw new BusinessOsShellDistributionError(code, message);
}

export function validateBusinessOsShellPackTrustMap(
  trustKeys: readonly CtoxMobileShellPackTrustKey[],
): ReadonlyMap<string, Uint8Array> {
  if (trustKeys.length === 0) {
    fail("trust-unavailable", "Business OS shell production trust keys are unavailable.");
  }
  const current = trustKeys.filter((key) => key.state === "current");
  const next = trustKeys.filter((key) => key.state === "next");
  if (current.length !== 1 || next.length !== 1 || trustKeys.length !== 2) {
    fail(
      "trust-map",
      "Business OS shell trust rotation must contain one current and one next key.",
    );
  }
  const publicKeys = new Map<string, Uint8Array>();
  for (const key of trustKeys) {
    if (
      key.algorithm !== "Ed25519" ||
      !key.signingKeyId.trim() ||
      !/^[0-9a-f]{64}$/u.test(key.publicKey) ||
      publicKeys.has(key.signingKeyId)
    ) {
      fail("trust-map", "Business OS shell trust map is invalid.");
    }
    publicKeys.set(key.signingKeyId, hexToBytes(key.publicKey));
  }
  return publicKeys;
}

export function validateBusinessOsShellPackDistribution(input: {
  readonly descriptor: CtoxMobileShellPackResolveResult;
  readonly expected: CtoxMobileShellPackResolveInput;
  readonly trustKeys: readonly CtoxMobileShellPackTrustKey[];
  readonly now?: number;
}): TrustedBusinessOsShellPackDistribution {
  const { descriptor } = input;
  if (
    descriptor.type !== "ctox.mobile.shell-pack-distribution.v1" ||
    descriptor.manifest.type !== "ctox.mobile.shell-pack.v1"
  ) {
    fail("descriptor", "Business OS shell distribution type is unsupported.");
  }
  if (
    descriptor.manifest.businessOsRevision !== input.expected.businessOsRevision ||
    descriptor.manifest.appVersion !== input.expected.appVersion
  ) {
    fail("compatibility", "Business OS shell distribution is not compatible with this app.");
  }
  let artifactUrl: URL;
  try {
    artifactUrl = new URL(descriptor.artifact.url);
  } catch {
    return fail("artifact", "Business OS shell artifact URL is invalid.");
  }
  if (
    artifactUrl.protocol !== "https:" ||
    artifactUrl.username !== "" ||
    artifactUrl.password !== "" ||
    artifactUrl.hash !== "" ||
    !Number.isSafeInteger(descriptor.artifact.size) ||
    descriptor.artifact.size <= 0 ||
    !/^[0-9a-f]{64}$/u.test(descriptor.artifact.sha256)
  ) {
    fail("artifact", "Business OS shell artifact metadata is unsafe.");
  }
  const expiresAtMs = Date.parse(descriptor.artifact.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= (input.now ?? Date.now())) {
    fail("artifact-expired", "Business OS shell artifact URL has expired.");
  }
  const publicKeys = validateBusinessOsShellPackTrustMap(input.trustKeys);
  if (!publicKeys.has(descriptor.manifest.signingKeyId)) {
    fail("untrusted-key", "Business OS shell pack was signed by an unknown key.");
  }
  return Object.freeze({ descriptor, publicKeys });
}
