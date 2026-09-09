import { DEFAULT_WORKJET_THREAD_CONFIG, type WorkjetThreadConfig } from "@workjet/contracts";
import type { ThreadRightPanelState } from "./rightPanelStore";

/** Mirrors the composer's root-draft guard; server configuration wins after promotion. */
export function workjetBrowserSurfaceEnabled(input: {
  isServerThread: boolean;
  serverConfig: WorkjetThreadConfig | null;
  draftConfig: WorkjetThreadConfig | null;
}): boolean {
  const draft = input.draftConfig?.role === "worker" ? null : input.draftConfig;
  const config = input.isServerThread
    ? input.serverConfig
    : (draft ?? DEFAULT_WORKJET_THREAD_CONFIG);
  return config?.enabledCapabilityIds.includes("web-stack-browser") ?? false;
}

/** Presentation only: preserve stored sessions, selection and panel visibility on disable. */
export function visibleWorkjetRightPanelState(
  state: ThreadRightPanelState,
  browserEnabled: boolean,
): ThreadRightPanelState {
  if (browserEnabled) return state;
  const surfaces = state.surfaces.filter((surface) => surface.kind !== "preview");
  if (surfaces.length === state.surfaces.length) return state;
  const activeSurfaceId =
    state.activeSurfaceId === null ||
    surfaces.some((surface) => surface.id === state.activeSurfaceId)
      ? state.activeSurfaceId
      : (surfaces[0]?.id ?? null);
  return { ...state, surfaces, activeSurfaceId };
}
