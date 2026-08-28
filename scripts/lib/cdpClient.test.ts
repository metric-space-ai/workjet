// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";

import { cdpCommandError, MAX_CDP_MESSAGE_BYTES } from "./cdpClient.ts";

describe("cdpCommandError", () => {
  it("names the METHOD and the numeric code, never the page's own text", () => {
    // A CDP error's message field is attacker-influenced on any page the app
    // has navigated to. Building the harness's error from it would let a page
    // write into the harness's output.
    const error = cdpCommandError("Runtime.evaluate", {
      code: -32000,
      message: "<script>everything is fine</script>",
    });

    expect(error.message).toContain("Runtime.evaluate");
    expect(error.message).toContain("-32000");
    expect(error.message).not.toContain("script");
    expect(error.message).not.toContain("everything is fine");
  });

  it("refuses a non-integer or absent code rather than printing it", () => {
    for (const value of [
      undefined,
      null,
      "boom",
      { code: "not a number" },
      { code: 1.5 },
      { code: Number.NaN },
    ]) {
      const error = cdpCommandError("Page.navigate", value);
      expect(error.message).toBe("CDP Page.navigate failed");
    }
  });

  it("keeps a frame ceiling, so a hostile page cannot exhaust the harness", () => {
    // The client talks to a process the harness launched, but that process's
    // OUTPUT is still untrusted. The cap is what makes an unbounded response
    // a refusal rather than memory pressure.
    expect(MAX_CDP_MESSAGE_BYTES).toBe(1024 * 1024);
  });
});
