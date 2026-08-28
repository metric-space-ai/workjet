import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

const MODULE_NAME = "T3BusinessOsLauncher";

interface NativeBusinessOsLauncherModule {
  readonly isSupported?: () => boolean;
}

export interface NativeBusinessOsLauncherProps extends ViewProps {
  readonly catalogJson: string;
  readonly layoutJson: string;
  readonly badgesJson: string;
  readonly instanceName: string;
  readonly showsSettingsAction: boolean;
  readonly onOpenApp: (event: NativeSyntheticEvent<{ readonly appId: string }>) => void;
  readonly onOpenSearch: () => void;
  readonly onOpenRecents: () => void;
  readonly onOpenSettings: () => void;
  readonly onReturnToCode: () => void;
  readonly onLayoutChange: (
    event: NativeSyntheticEvent<{
      readonly sourceIndex: number;
      readonly targetIndex: number;
      readonly pageIndex: number;
    }>,
  ) => void;
}

let cachedView: ComponentType<NativeBusinessOsLauncherProps> | null | undefined;

function module(): NativeBusinessOsLauncherModule | null {
  try {
    return requireOptionalNativeModule<NativeBusinessOsLauncherModule>(MODULE_NAME);
  } catch {
    return null;
  }
}

export function resolveNativeBusinessOsLauncher(): ComponentType<NativeBusinessOsLauncherProps> | null {
  if (cachedView !== undefined) return cachedView;
  try {
    cachedView =
      module()?.isSupported?.() === true
        ? requireNativeView<NativeBusinessOsLauncherProps>(MODULE_NAME)
        : null;
  } catch {
    cachedView = null;
  }
  return cachedView;
}
