import { RotateCcwIcon, XIcon } from "lucide-react";
import {
  Navigate,
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { useCtoxMode } from "../components/ctox/CtoxModeShell";
import { resolveSettingsInstanceContext } from "../components/settings/settingsInstanceContext";
import { Button } from "../components/ui/button";
import { useUiText } from "../hooks/useUiText";
import { SettingsCompactNav, SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import { useClientSettings } from "../hooks/useSettings";
import { closeOpenInlineExpand } from "~/components/ui/inline-expand";
import { collapseExpandedSettingsRow } from "~/components/settings/settingsEscape";

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  const [confirming, setConfirming] = useState(false);

  if (confirming)
    return (
      <span className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="destructive"
          onClick={() => {
            setConfirming(false);
            void restoreDefaults({ confirmed: true });
          }}
        >
          Zurücksetzen
        </Button>
        <Button size="xs" variant="outline" onClick={() => setConfirming(false)}>
          Abbrechen
        </Button>
      </span>
    );
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => setConfirming(true)}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Standard wiederherstellen
    </Button>
  );
}

function SettingsContentLayout() {
  const { discovery, selectedId } = useCtoxMode();
  const instanceContext = resolveSettingsInstanceContext(
    discovery,
    selectedId,
    typeof window !== "undefined" && window.desktopBridge?.ctox !== undefined,
  );
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const t = useUiText();
  // Instanzen und Verbrauch brauchen keinen Instanzkontext.
  const isInstanceManagement =
    location.pathname === "/settings/business-os" || location.pathname === "/settings/usage";
  const canShowSettings = isInstanceManagement || instanceContext.canEditInstanceSettings;
  const developerMode = useClientSettings((settings) => settings.developerMode);
  // „Standard wiederherstellen“ ist ein Entwicklerwerkzeug: nur im Entwicklermodus.
  const showRestoreDefaults =
    developerMode &&
    location.pathname === "/settings/general" &&
    instanceContext.canEditInstanceSettings;
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();

        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          activeElement.blur();
        }

        // An open inline editor means unsaved work — Escape must not tear
        // down the whole settings view over it (Befund F14). Leaving a text
        // field is one Escape; closing the editor stays its Cancel button's
        // job; only a form-free view closes on Escape.
        if (document.querySelector("[data-settings-inline-editor]") !== null) {
          return;
        }

        // Esc only collapses what is open (an expanded row, an inline editor);
        // it never leaves Einstellungen while something is expanded.
        if (closeOpenInlineExpand()) return;
        if (collapseExpandedSettingsRow()) return;

        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <>
      {/* Settings are a near-fullscreen sheet over the dimmed app (#627). */}
      <div
        aria-hidden
        className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]"
        onClick={navigateBackWithinApp}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Einstellungen", "Settings")}
        data-workjet-settings-sheet=""
        className="fixed inset-2 z-50 flex min-h-0 overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-2xl sm:inset-6 lg:inset-x-16 lg:inset-y-8"
      >
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground sm:flex">
          <SettingsSidebarNav pathname={location.pathname} />
        </aside>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t("Einstellungen schließen", "Close settings")}
          data-workjet-action="settings.close"
          onClick={navigateBackWithinApp}
          className="absolute top-1 right-1 z-10 size-10 sm:top-2 sm:right-2"
        >
          <XIcon className="size-5" />
        </Button>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-popover text-foreground">
          <div className="sm:hidden">
            <SettingsCompactNav pathname={location.pathname} />
          </div>
          <div className="hidden h-14 shrink-0 items-center px-3 pe-14 sm:flex sm:px-5 sm:pe-14">
            <div className="flex w-full min-w-0 items-center gap-2">
              <SettingsBreadcrumb
                pathname={location.pathname}
                activeInstanceName={
                  instanceContext.isMultiInstance ? instanceContext.activeInstanceName : null
                }
              />
              {showRestoreDefaults ? (
                <div className="no-drag ms-auto flex items-center gap-2">
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </div>
              ) : null}
            </div>
          </div>

          <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
            {canShowSettings ? (
              <Outlet />
            ) : discovery === "loading" ? (
              <p role="status" className="px-6 py-8 text-sm text-muted-foreground">
                Instanzen werden geladen …
              </p>
            ) : (
              <Navigate to="/settings/business-os" replace />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "desktop-local"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
