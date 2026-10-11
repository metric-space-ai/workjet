import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CtoxWorkjetProjectControlDiagnostic } from "./ctox.ts";

describe("project-control timeout diagnostics", () => {
  const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlDiagnostic, {
    onExcessProperty: "error",
  });
  it("accepts existing diagnostics and a bounded optional timeout phase", () => {
    const diagnostic = { stage: "execute", reason: "request_timeout" };
    expect(decode(diagnostic)).toEqual(diagnostic);
    expect(decode({ ...diagnostic, phase: "native_projection" })).toEqual({
      ...diagnostic,
      phase: "native_projection",
    });
  });
  it("rejects arbitrary phase text and extra private data", () => {
    expect(() =>
      decode({ stage: "execute", reason: "request_timeout", phase: "private-value" }),
    ).toThrow();
    expect(() =>
      decode({ stage: "execute", reason: "request_timeout", phase: "command", message: "private" }),
    ).toThrow();
  });
});
