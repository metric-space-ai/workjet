import { type ServerLifecycleWelcomePayload } from "@workjet/contracts";
import { installPrivacyMode } from "../privacyMode";
import { scopedProjectKey, scopeProjectRef } from "@workjet/client-runtime/environment";
import {
  Outlet,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { RouteErrorPage, RouteNotFoundPage } from "../components/RouteFallbackPage";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { DeepLinkConfirmationNotice } from "../components/desktop/DeepLinkConfirmationNotice";
import { UserDataMigrationNotice } from "../components/desktop/UserDataMigrationNotice";
import { ConnectionCatalogWarning } from "../components/desktop/ConnectionCatalogWarning";
import { ConnectOnboardingPanel } from "../components/cloud/ConnectOnboardingPanel";
import { RelayClientInstallPanel } from "../components/cloud/RelayClientInstallPanel";
import { SshPasswordPromptNotice } from "../components/desktop/SshPasswordPromptNotice";
import { ProviderUpdateLaunchNotification } from "../components/ProviderUpdateLaunchNotification";
import { SlowRpcRequestToastCoordinator } from "../components/SlowRpcRequestToastCoordinator";
import {
  AnchoredToastProvider,
  stackedThreadToast,
  ToastProvider,
  toastManager,
} from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { DEFAULT_UNIFIED_SETTINGS } from "@workjet/contracts/settings";
import { applyAppearanceFontVariables } from "~/appearanceFonts";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import { configureClientTracing } from "../observability/clientTracing";
import { resolveInitialAppShellGateState } from "../environments/primary";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import { shellEnvironment } from "../state/shell";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  primaryServerConfigAtom,
  primaryServerConfigEventAtom,
  primaryServerWelcomeAtom,
} from "../state/server";
import { readProject, setActiveEnvironmentId, useActiveEnvironmentId } from "../state/entities";
import {
  KEYBINDINGS_UPDATE_TOAST_COPY,
  createKeybindingsUpdateToastController,
  type KeybindingsUpdateToastController,
} from "../components/KeybindingsUpdateToast.logic";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isHostedStaticApp(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const authGateState = await resolveInitialAppShellGateState();
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RouteNotFoundPage,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";
  const primarySubscriptionsEnabled =
    primaryEnvironmentAuthenticated || authGateState.status === "desktop-local";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  if (pathname === "/pair" || pathname === "/connect" || pathname.startsWith("/connect/")) {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  if (
    authGateState.status !== "authenticated" &&
    authGateState.status !== "hosted-static" &&
    authGateState.status !== "desktop-local"
  ) {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  const appShell = (
    <AppSidebarLayout>
      <CommandPalette>
        <Outlet />
      </CommandPalette>
    </AppSidebarLayout>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <DocumentTitleSync />
        <FontAppearanceSync />
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        <RelayClientInstallPanel />
        <ConnectOnboardingPanel />
        <SshPasswordPromptNotice />
        <UserDataMigrationNotice />
        <DeepLinkConfirmationNotice />
        <ConnectionCatalogWarning />
        <ConfirmDialogHost />
        <SlowRpcRequestToastCoordinator />
        <HostedStaticEnvironmentBootstrap />
        {primarySubscriptionsEnabled ? <EventRouter /> : null}
        {primarySubscriptionsEnabled ? <ProviderUpdateLaunchNotification /> : null}
        {appShell}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function FontAppearanceSync() {
  const fontSizeInterface = useClientSettings((settings) => settings.fontSizeInterface);
  const fontSizePrompt = useClientSettings((settings) => settings.fontSizePrompt);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);

  useEffect(() => {
    applyAppearanceFontVariables(document.documentElement, {
      // Schriftfamilien, Glas und Kantenglättung sind entfallen (#553): gespeicherte
      // Altwerte wirken nicht mehr, es gelten die Standardwerte.
      sans: "",
      code: "",
      composer: "",
      sizeInterface: fontSizeInterface,
      sizePrompt: fontSizePrompt,
      sizeCode: fontSizeCode,
      smoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing,
    });
  }, [fontSizeCode, fontSizeInterface, fontSizePrompt]);

  return null;
}

function DocumentTitleSync() {
  useEffect(() => {
    document.title = APP_DISPLAY_NAME;
  }, []);
  // Privacy mode (#526): stored flag, Cmd/Ctrl+Shift+B. The window title is
  // always the app name, so it never names a project.
  useEffect(
    () => installPrivacyMode(typeof navigator !== "undefined" && /mac/i.test(navigator.platform)),
    [],
  );

  return null;
}

function HostedStaticEnvironmentBootstrap() {
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();

  useEffect(() => {
    if (
      environments.some(
        (environment) => environment.entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return;
    }

    if (activeEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = environments[0];
    if (!firstSavedEnvironment) {
      return;
    }

    setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [activeEnvironmentId, environments]);

  return null;
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  return <RouteErrorPage error={error} reset={reset} />;
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EventRouter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironment = usePrimaryEnvironment();
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverConfigEvent = useAtomValue(primaryServerConfigEventAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const handledConfigEventRef = useRef(serverConfigEvent);
  const [keybindingsToastController] = useState<KeybindingsUpdateToastController>(() =>
    createKeybindingsUpdateToastController({}),
  );

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    setActiveEnvironmentId(payload.environment.environmentId);
    void (async () => {
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapProject = readProject(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(() => {
    const decision = keybindingsToastController.handle(serverConfigEvent);
    if (!decision) {
      return;
    }

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: KEYBINDINGS_UPDATE_TOAST_COPY.success.title,
      });
      return;
    }

    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: KEYBINDINGS_UPDATE_TOAST_COPY.invalid.title,
        actionVariant: "outline",
        actionProps: {
          children: KEYBINDINGS_UPDATE_TOAST_COPY.invalid.action,
          onClick: () => {
            if (!serverConfig || !primaryEnvironment) {
              return;
            }

            const editor = resolveAndPersistPreferredEditor(serverConfig.availableEditors);
            if (!editor) {
              return;
            }
            void (async () => {
              const result = await openInEditor({
                environmentId: primaryEnvironment.environmentId,
                input: {
                  cwd: serverConfig.keybindingsConfigPath,
                  editor,
                },
              });
              if (result._tag === "Success") {
                return;
              }
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "keybindings.json lässt sich nicht öffnen",
                }),
              );
            })();
          },
        },
      }),
    );
  });

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig]);

  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  useEffect(() => {
    if (serverConfigEvent === null || handledConfigEventRef.current === serverConfigEvent) {
      return;
    }
    handledConfigEventRef.current = serverConfigEvent;
    handleServerConfigUpdated();
  }, [serverConfigEvent]);

  return null;
}
