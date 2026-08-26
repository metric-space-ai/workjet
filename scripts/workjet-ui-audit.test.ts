import { describe, expect, it } from "@effect/vitest";

import {
  CODE_AUDIT_STATES,
  BUSINESS_OS_AUDIT_STATES,
  createReviewBatches,
  parseAuditArguments,
  selectWorkjetTarget,
  summarizeAudit,
} from "./workjet-ui-audit.ts";

describe("Workjet UI audit configuration", () => {
  it("covers every Code settings route and primary page", () => {
    expect(CODE_AUDIT_STATES.map(({ name }) => name)).toEqual([
      "draft",
      "settings-general",
      "settings-appearance",
      "settings-keybindings",
      "settings-harnesses",
      "settings-models",
      "settings-computers",
      "settings-worker",
      "settings-source-control",
      "settings-connections",
      "settings-diagnostics",
      "settings-archive",
      "machines",
      "usage",
      "pull-requests",
      "draft-attachment-menu",
      "draft-worker-menu",
      "draft-computer-menu",
      "draft-harness-menu",
      "draft-model-menu",
      "draft-reasoning-menu",
      "draft-system-prompt",
      "draft-tools-menu",
      "draft-command-palette",
      "draft-terminal",
      "draft-right-panel",
    ]);
  });

  it("covers Workjet-owned Business OS chrome and every settings category", () => {
    expect(BUSINESS_OS_AUDIT_STATES.map(({ name }) => name)).toEqual([
      "business-home",
      "business-add-instance",
      "business-instance-actions",
      "business-expanded-instance",
      "business-settings-general",
      "business-settings-backends",
      "business-settings-apps",
      "business-settings-updates",
      "business-settings-appearance",
      "business-settings-notifications",
      "business-settings-diagnostics",
      "business-settings-about",
    ]);
  });

  it("parses a bounded loopback port and absolute output", () => {
    expect(
      parseAuditArguments([
        "--",
        "--port",
        "9300",
        "--output",
        "/tmp/workjet-audit",
        "--states",
        "draft,settings-general",
        "--viewports",
        "compact,narrow,small",
      ]),
    ).toEqual({
      port: 9300,
      output: "/tmp/workjet-audit",
      states: ["draft", "settings-general"],
      viewports: ["compact", "narrow", "small"],
    });
    expect(() => parseAuditArguments(["--port", "70000"])).toThrow("port");
    expect(() => parseAuditArguments(["--output", "relative"])).toThrow("absolute");
    expect(() => parseAuditArguments(["--states", "missing"])).toThrow("unknown audit state");
  });

  it("selects only the Workjet application target", () => {
    expect(
      selectWorkjetTarget([
        {
          id: "devtools",
          type: "page",
          url: "devtools://devtools",
          webSocketDebuggerUrl: "ws://127.0.0.1:9300/devtools",
        },
        {
          id: "guest",
          type: "page",
          url: "https://guest.example",
          webSocketDebuggerUrl: "ws://127.0.0.1:9300/guest",
        },
        {
          id: "app",
          type: "page",
          url: "t3code-dev://app/#/",
          webSocketDebuggerUrl: "ws://127.0.0.1:9300/app",
        },
      ]).id,
    ).toBe("app");
  });

  it("counts blocking findings independently from truncation inventory", () => {
    expect(
      summarizeAudit([
        {
          state: "draft",
          viewport: "wide",
          screenshot: "wide-draft.png",
          location: "#/",
          title: "Workjet",
          documentOverflowX: 0,
          clippedInteractive: [],
          duplicateActions: [],
          tinyControls: [],
          truncatedText: [{ label: "deliberate" }],
          consoleErrors: [],
          modalViolations: [],
        },
      ]),
    ).toEqual({ captures: 1, failingCaptures: 0, findings: 0, warnings: 1 });
  });

  it("treats modal focus and accessibility failures as blocking findings", () => {
    expect(
      summarizeAudit([
        {
          state: "business-settings-general",
          viewport: "narrow",
          screenshot: "narrow-business-settings-general.png",
          location: "#/",
          title: "Workjet",
          documentOverflowX: 0,
          clippedInteractive: [],
          duplicateActions: [],
          tinyControls: [],
          truncatedText: [],
          consoleErrors: [],
          modalViolations: ["settings trigger did not regain focus"],
        },
      ]),
    ).toEqual({ captures: 1, failingCaptures: 1, findings: 1, warnings: 0 });
  });

  it("never assigns more than four screenshots to one visual review batch", () => {
    expect(createReviewBatches([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9],
    ]);
    expect(() => createReviewBatches([1], 5)).toThrow("1 through 4");
  });
});
