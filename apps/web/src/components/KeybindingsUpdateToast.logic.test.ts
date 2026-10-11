import type { ServerConfigStreamEvent } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createKeybindingsUpdateToastController,
  KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS,
  KEYBINDINGS_UPDATE_TOAST_COPY,
} from "./KeybindingsUpdateToast.logic";

function keybindingsEvent(
  overrides: Partial<Extract<ServerConfigStreamEvent, { type: "keybindingsUpdated" }>> = {},
): Extract<ServerConfigStreamEvent, { type: "keybindingsUpdated" }> {
  return {
    version: 1,
    type: "keybindingsUpdated",
    payload: {
      keybindings: [],
      issues: [],
    },
    ...overrides,
  };
}

describe("keybindings update toast policy", () => {
  it("coalesces repeated successful reload notifications during the cooldown", () => {
    let now = 1_000;
    const controller = createKeybindingsUpdateToastController({
      now: () => now,
    });

    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: "Success" });

    now += KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS - 1;
    expect(controller.handle(keybindingsEvent())).toBeNull();

    now += 1;
    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: "Success" });
  });

  it("surfaces keybinding configuration issues", () => {
    const controller = createKeybindingsUpdateToastController({});

    expect(
      controller.handle(
        keybindingsEvent({
          payload: {
            keybindings: [],
            issues: [
              {
                kind: "keybindings.malformed-config",
                message: "Expected JSON array",
              },
            ],
          },
        }),
      ),
    ).toEqual({
      _tag: "InvalidConfiguration",
      message: "Expected JSON array",
    });
  });

  it("ignores unrelated server config notifications", () => {
    const controller = createKeybindingsUpdateToastController({});

    expect(
      controller.handle({
        version: 1,
        type: "settingsUpdated",
        payload: { settings: {} as never },
      }),
    ).toBeNull();
  });
});

describe("keybindings toast copy", () => {
  it("is one German line with at most one action", () => {
    expect(KEYBINDINGS_UPDATE_TOAST_COPY.success.title).toBe("Tastenkürzel neu geladen");
    expect(KEYBINDINGS_UPDATE_TOAST_COPY.invalid.title).toBe("Tastenkürzel ungültig");
    expect(KEYBINDINGS_UPDATE_TOAST_COPY.invalid.action).toBe("keybindings.json öffnen");
    for (const copy of Object.values(KEYBINDINGS_UPDATE_TOAST_COPY)) {
      expect(copy.title).not.toMatch(/[.\n]/);
      expect(copy.title.split(/\s+/).length).toBeLessThanOrEqual(12);
    }
  });
});
