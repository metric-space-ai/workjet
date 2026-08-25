import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

const MODULE_NAME = "T3BusinessOsSurface";

interface NativeBusinessOsSurfaceModule {
  readonly isSupported?: () => boolean;
  readonly removeProfile?: (storageIdentity: string) => Promise<void>;
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
