export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Im Finder zeigen";
  if (normalized.includes("win")) return "Im Explorer zeigen";
  return "In Dateien zeigen";
}
