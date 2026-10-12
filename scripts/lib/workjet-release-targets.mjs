export const RELEASE_TARGETS = [
  ["macos", "arm64", ".dmg"],
  ["macos", "x64", ".dmg"],
  ["linux", "arm64", ".AppImage"],
  ["linux", "x64", ".AppImage"],
  ["windows", "x64", ".exe"],
];

// An explicit scope permits intentionally unsupported platforms, never a missing
// artifact within that scope. Omitting it preserves the complete release guard.
export function selectReleaseTargets(selection) {
  if (selection === undefined) return RELEASE_TARGETS;
  const names = selection.split(",");
  if (!names.length || new Set(names).size !== names.length) {
    throw new Error("Release targets must be nonempty and unique");
  }
  return names.map((name) => {
    const target = RELEASE_TARGETS.find(([platform, arch]) => `${platform}/${arch}` === name);
    if (!target) throw new Error(`Unknown release target: ${name}`);
    return target;
  });
}
