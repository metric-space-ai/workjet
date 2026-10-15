// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/** Key ordering cannot change an immutable worker intent. Array ordering
 * remains significant, including explicitly delegated capability grants.
 * Callers must validate/encode their schema before hashing this JSON value. */
export const canonicalWorkerJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkerJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalWorkerJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
