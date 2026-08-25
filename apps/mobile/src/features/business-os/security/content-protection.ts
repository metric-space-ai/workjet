import { requireOptionalNativeModule } from "expo";

interface NativeBusinessOsContentProtection {
  readonly setBusinessOsContentProtected?: (enabled: boolean) => void;
}

function nativeControls(): NativeBusinessOsContentProtection | null {
  try {
    return requireOptionalNativeModule<NativeBusinessOsContentProtection>("T3NativeControls");
  } catch {
    return null;
  }
}

export function setBusinessOsContentProtected(enabled: boolean): boolean {
  const setter = nativeControls()?.setBusinessOsContentProtected;
  if (!setter) return false;
  setter(enabled);
  return true;
}
