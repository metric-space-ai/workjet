import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

const MODULE_NAME = "T3BusinessOsSurface";

interface NativeBusinessOsSurfaceModule {
  readonly isSupported?: () => boolean;
  readonly removeProfile?: (storageIdentity: string) => Promise<void>;
  readonly getDeviceProofKey?: () => Promise<NativeWorkjetDeviceProofKey>;
  readonly signDeviceProofMessage?: (message: string) => Promise<NativeWorkjetDeviceProof>;
}

export interface NativeWorkjetDeviceProofPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface NativeWorkjetDeviceProofKey {
  readonly publicJwk: NativeWorkjetDeviceProofPublicJwk;
  readonly thumbprint: string;
}

export interface NativeWorkjetDeviceProof extends NativeWorkjetDeviceProofKey {
  readonly signature: string;
}

export interface NativeBusinessOsSurfaceProps extends ViewProps {
  readonly storageIdentity: string;
  readonly shellRootUri: string;
  readonly sessionJson: string;
  readonly configJson: string;
  readonly launchKey: string;
  readonly commandJson?: string;
  readonly onError?: (event: NativeSyntheticEvent<{ readonly code: string }>) => void;
  readonly onNotification?: (
    event: NativeSyntheticEvent<{
      readonly kind: string;
      readonly title: string;
      readonly body: string;
      readonly tag?: string;
      readonly recordId?: string;
      readonly urgency?: string;
    }>,
  ) => void;
  readonly onShellMessage?: (event: NativeSyntheticEvent<{ readonly message: string }>) => void;
}

let cachedView: ComponentType<NativeBusinessOsSurfaceProps> | null | undefined;

function module(): NativeBusinessOsSurfaceModule | null {
  try {
    return requireOptionalNativeModule<NativeBusinessOsSurfaceModule>(MODULE_NAME);
  } catch {
    return null;
  }
}

export function resolveNativeBusinessOsSurface(): ComponentType<NativeBusinessOsSurfaceProps> | null {
  if (cachedView !== undefined) return cachedView;
  try {
    cachedView = module() ? requireNativeView<NativeBusinessOsSurfaceProps>(MODULE_NAME) : null;
  } catch {
    cachedView = null;
  }
  return cachedView;
}

export function isNativeBusinessOsSurfaceSupported(): boolean {
  try {
    return module()?.isSupported?.() === true;
  } catch {
    return false;
  }
}

export const nativeBusinessOsProfileStore = {
  async remove(storageIdentity: string): Promise<void> {
    const removeProfile = module()?.removeProfile;
    if (!removeProfile) throw new Error("Business OS native profile control is unavailable.");
    await removeProfile(storageIdentity);
  },
};

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_P256_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

function validateDeviceProofKey(value: NativeWorkjetDeviceProofKey): NativeWorkjetDeviceProofKey {
  if (
    value?.publicJwk?.kty !== "EC" ||
    value.publicJwk.crv !== "P-256" ||
    !BASE64URL_32_BYTES.test(value.publicJwk.x) ||
    !BASE64URL_32_BYTES.test(value.publicJwk.y) ||
    !BASE64URL_32_BYTES.test(value.thumbprint)
  ) {
    throw new Error("Workjet device proof key is invalid.");
  }
  return Object.freeze({
    publicJwk: Object.freeze({ ...value.publicJwk }),
    thumbprint: value.thumbprint,
  });
}

export const nativeWorkjetDeviceProof = {
  async key(): Promise<NativeWorkjetDeviceProofKey> {
    const load = module()?.getDeviceProofKey;
    if (!load) throw new Error("Native Workjet device proof is unavailable.");
    return validateDeviceProofKey(await load());
  },
  async sign(message: string): Promise<NativeWorkjetDeviceProof> {
    if (!message || new TextEncoder().encode(message).byteLength > 4_096) {
      throw new Error("Workjet device proof message is invalid.");
    }
    const sign = module()?.signDeviceProofMessage;
    if (!sign) throw new Error("Native Workjet device proof is unavailable.");
    const proof = await sign(message);
    const key = validateDeviceProofKey(proof);
    if (!BASE64URL_P256_SIGNATURE.test(proof.signature)) {
      throw new Error("Workjet device proof signature is invalid.");
    }
    return Object.freeze({ ...key, signature: proof.signature });
  },
};
