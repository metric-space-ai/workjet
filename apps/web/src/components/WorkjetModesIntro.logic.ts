/**
 * The intro is a first-start explanation of the two product modes. Dev and
 * Ops exist only in the desktop shell (see `resolveWorkjetProductMode`), so the
 * intro never opens in a browser where the other mode cannot be reached.
 */
export function resolveWorkjetModesIntroOpen(input: {
  readonly isElectron: boolean;
  readonly settingsHydrated: boolean;
  readonly seen: boolean;
  readonly workspaceHydrated?: boolean;
  readonly hasExistingWork?: boolean;
}): boolean {
  return (
    input.isElectron &&
    input.settingsHydrated &&
    input.workspaceHydrated !== false &&
    !input.hasExistingWork &&
    !input.seen
  );
}
