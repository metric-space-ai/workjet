import { BusinessOsMobileRoot } from "../business-os/launcher/BusinessOsMobileRoot";

export function BusinessOsSetupScreen(props: {
  readonly active: boolean;
  readonly onOpenSettings: () => void;
}) {
  return <BusinessOsMobileRoot active={props.active} onOpenSettings={props.onOpenSettings} />;
}
