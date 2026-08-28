export type WorkjetMode = "code" | "business_os";

export function resolveWorkjetMode(value: unknown): WorkjetMode {
  return value === "business_os" ? "business_os" : "code";
}

export function workjetModeLabel(mode: WorkjetMode): "Code" | "Business OS" {
  return mode === "business_os" ? "Business OS" : "Code";
}
