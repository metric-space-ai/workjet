import type { CtoxWorkjetProjectControlRequest } from "@workjet/contracts";

/** Correlation IDs remain part of the key; mutations never share execution. */
export function projectControlReadKey(request: CtoxWorkjetProjectControlRequest): string | null {
  if (request.action !== "project.list" && !request.action.endsWith(".read")) return null;
  return JSON.stringify(request, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}
