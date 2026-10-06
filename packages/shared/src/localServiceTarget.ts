import { TrimmedNonEmptyString } from "@workjet/contracts";
import * as Schema from "effect/Schema";

/** Main-process/CLI metadata. No credential belongs in this public target document. */
export const LocalServiceTarget = Schema.Struct({
  version: Schema.Literal(1),
  baseDir: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  runtimeInstanceId: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
});
export type LocalServiceTarget = typeof LocalServiceTarget.Type;

/** Avoid DNS, redirects and arbitrary origins when attaching to a local profile. */
export function isLocalServiceOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
