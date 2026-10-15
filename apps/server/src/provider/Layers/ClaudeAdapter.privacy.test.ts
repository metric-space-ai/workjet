import { describe, expect, it } from "vite-plus/test";

import { withClaudeCodePrivacyDefaults } from "./ClaudeAdapter.ts";

describe("Claude Code worker privacy defaults (owner rule 2026-10-15)", () => {
  it("turns off telemetry, error reporting and non-essential traffic", () => {
    expect(withClaudeCodePrivacyDefaults({ PATH: "/bin" }, {})).toEqual({
      PATH: "/bin",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it("keeps values the user set, in the worker env or their own env", () => {
    const env = withClaudeCodePrivacyDefaults(
      { DISABLE_TELEMETRY: "0" },
      { DISABLE_ERROR_REPORTING: "0" },
    );
    expect(env.DISABLE_TELEMETRY).toBe("0");
    expect(env.DISABLE_ERROR_REPORTING).toBe("0");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });
});
