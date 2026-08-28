import { BusinessOsMobileRoot } from "../business-os/launcher/BusinessOsMobileRoot";

export function BusinessOsSetupScreen(props: { readonly active: boolean }) {
  return <BusinessOsMobileRoot active={props.active} />;
}
