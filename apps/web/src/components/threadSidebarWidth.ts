export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
// The desktop titlebar cluster contains the macOS-safe sidebar control and the
// complete Code / Business OS switch. Keep both panes usable at the supported
// compact 840px desktop width without clipping or overlaying the main header.
export const THREAD_SIDEBAR_MIN_WIDTH = 15.5 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 37 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
