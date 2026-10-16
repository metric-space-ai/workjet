import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { useProjectOverviewLanguage } from "./hooks/useProjectOverviewLanguage";
import { useWorkjetSessionPauseObserver } from "./hooks/useWorkjetSessionPauseObserver";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function WorkjetSessionPauseObserverHost() {
  useWorkjetSessionPauseObserver();
  return null;
}

/**
 * Die gewählte Oberflächensprache gilt für die ganze App (#800): `<html lang>` folgt der
 * Einstellung (viele Texte lesen sie über `workjetUiLanguage()`), und ein Wechsel
 * zeichnet die geroutete Oberfläche neu, statt halb deutsch stehen zu bleiben.
 */
export function LanguageScopedRouter({ router }: { readonly router: AppRouter }) {
  const language = useProjectOverviewLanguage();
  if (typeof document !== "undefined" && document.documentElement.lang !== language) {
    document.documentElement.lang = language;
  }
  return <RouterProvider key={language} router={router} />;
}

export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <WorkjetSessionPauseObserverHost />
      <LanguageScopedRouter router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
    </AppAtomRegistryProvider>
  );
}
