import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/workjet.service",
  logPath: "/home/me/.workjet/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "Workjet service",
      "  Status: installed · workjet@0.0.29",
      "  Unit: /home/me/.config/systemd/user/workjet.service",
      "  Logs: /home/me/.workjet/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx workjet@latest service update`.",
  );
});

it("explains service availability", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd or macOS with a user login session",
  );
});

it("does not promise that a macOS user agent survives logout", () => {
  assert.include(
    formatServiceStatus({ ...status, loginSessionOnly: true }, "0.0.29"),
    "Lifetime: runs while you are logged in; stops at logout.",
  );
});
