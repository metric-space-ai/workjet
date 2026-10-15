/**
 * Collapses the most recently rendered expanded disclosure row in the settings
 * content (aria-expanded toggles), skipping menus, selects and the sidebar.
 */
export function collapseExpandedSettingsRow(root: ParentNode = document): boolean {
  const toggles = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[aria-expanded="true"]:not([aria-haspopup]):not([role="combobox"])',
    ),
  ).filter(
    (element) =>
      element.closest('[data-sidebar="sidebar"],[role="menu"],[role="listbox"]') === null,
  );
  const toggle = toggles.at(-1);
  if (!toggle) return false;
  toggle.click();
  return true;
}
