"use client";
/**
 * Former command palette, now a plain provider without any dialog (drei Orte,
 * keine Popups). It keeps the global shortcuts and bus requests working by
 * mapping them onto inline places:
 *
 * - `commandPalette.toggle` (⌘K) and a bare `openCommandPalette()` focus the
 *   sidebar search field „Suchen“;
 * - `openCommandPalette({ open: "add-project" })` opens the project gallery
 *   with its inline „Projekt anlegen“ panel;
 * - `openCommandPalette({ open: "new-thread-in" })` (the `chat.new` shortcut
 *   in multi-project setups) starts a new thread in the contextual project;
 * - `themeEditor.toggle` keeps toggling the theme editor.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef } from "react";

import { readActiveWorkjetScope } from "../activeWorkjetScope";
import {
  focusSidebarSearch,
  onOpenCommandPalette,
  requestProjectCreate,
} from "../commandPaletteBus";
import { ComposerHandleContext } from "../composerHandleContext";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useTheme } from "../hooks/useTheme";
import { resolveShortcutCommand } from "../keybindings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectProjectOverviewRef } from "../projectOverviewSelection";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { selectWorkjetProject } from "../workjetProjectRegistry";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { useSidebar } from "./ui/sidebar";

/** Show the project gallery (not a selected project's overview) at "/". */
export function showProjectGallery(): void {
  const instanceId = readActiveWorkjetScope().selectedInstanceId;
  if (instanceId !== null) selectWorkjetProject(instanceId, null);
  selectProjectOverviewRef(instanceId, null);
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  const focusSearch = useCallback(() => {
    if (focusSidebarSearch()) return;
    // A collapsed sidebar renders no search field: open it, then focus.
    if (sidebar.isMobile) sidebar.setOpenMobile(true);
    else sidebar.setOpen(true);
    window.requestAnimationFrame(() => {
      focusSidebarSearch();
    });
  }, [sidebar]);

  const openProjectCreate = useCallback(() => {
    requestProjectCreate();
    showProjectGallery();
    void navigate({ to: "/" });
  }, [navigate]);

  const startNewThread = useCallback(() => {
    void startNewThreadFromContext({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    }).then((started) => {
      if (!started) openProjectCreate();
    });
  }, [activeDraftThread, activeThread, defaultProjectRef, handleNewThread, openProjectCreate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command === "commandPalette.toggle") {
        event.preventDefault();
        event.stopPropagation();
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSearch, keybindings, previewOpen, resolvedTheme, terminalOpen, theme, themeHalves]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "add-project") {
          openProjectCreate();
        } else if (detail.open === "new-thread-in") {
          startNewThread();
        } else {
          focusSearch();
        }
      }),
    [focusSearch, openProjectCreate, startNewThread],
  );

  return <ComposerHandleContext value={composerHandleRef}>{children}</ComposerHandleContext>;
}
