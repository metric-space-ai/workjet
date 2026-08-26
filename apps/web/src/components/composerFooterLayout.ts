// The full control flow is intentionally allowed to wrap to two or three
// rows. Collapsing it at tablet/compact-desktop widths hid important choices
// behind an ellipsis and made the composer look broken. The menu is now only
// the last-resort phone layout.
export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 400;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 520;
// Pending approval/plan actions can still shorten before the control flow
// itself collapses; these buttons are materially wider than the send button.
export const COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX = 780;

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX;
}
