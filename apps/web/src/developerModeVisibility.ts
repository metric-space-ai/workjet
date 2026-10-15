import type { RightPanelKind, ThreadRightPanelState } from "./rightPanelStore";

/**
 * Coding-agent heritage (PR page, diff, terminal, branch strip, git actions)
 * is only reachable in developer mode (#557). Everything here is presentation
 * only: stored panels, terminals and sessions stay untouched, so switching the
 * mode back on shows the same state as before.
 */
const CODING_RIGHT_PANEL_KINDS: ReadonlySet<RightPanelKind> = new Set<RightPanelKind>([
  "terminal",
  "diff",
  "pull-request",
]);

export function isCodingRightPanelKind(kind: RightPanelKind): boolean {
  return CODING_RIGHT_PANEL_KINDS.has(kind);
}

/** Keyboard commands that open or drive the terminal or the diff. */
export function isCodingToolCommand(command: string): boolean {
  return command === "diff.toggle" || command.startsWith("terminal.");
}

export function visibleDeveloperRightPanelState(
  state: ThreadRightPanelState,
  developerMode: boolean,
): ThreadRightPanelState {
  if (developerMode) return state;
  const surfaces = state.surfaces.filter((surface) => !isCodingRightPanelKind(surface.kind));
  if (surfaces.length === state.surfaces.length) return state;
  const activeSurfaceId =
    state.activeSurfaceId === null ||
    surfaces.some((surface) => surface.id === state.activeSurfaceId)
      ? state.activeSurfaceId
      : (surfaces[0]?.id ?? null);
  return { ...state, surfaces, activeSurfaceId };
}
