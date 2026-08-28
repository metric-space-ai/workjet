export type MobileStageLabel = "Dev" | "Preview" | null;

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Preview";
  return null;
}
