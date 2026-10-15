import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeRelayClientInstallPanelClose,
  finishRelayClientInstall,
  readRelayClientInstallPanelState,
  RelayClientInstallConfirmationConflictError,
  reportRelayClientInstallProgress,
  requestRelayClientInstallConfirmation,
  resetRelayClientInstallPanelForTests,
  respondToRelayClientInstallConfirmation,
} from "./relayClientInstallPanel";

describe("relay client install dialog coordinator", () => {
  beforeEach(() => {
    resetRelayClientInstallPanelForTests();
  });

  it("moves a confirmed installation through streamed progress stages", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.5.2");
    expect(readRelayClientInstallPanelState()).toEqual({
      status: "confirming",
      version: "2026.5.2",
    });

    respondToRelayClientInstallConfirmation(true);
    await expect(confirmation).resolves.toBe(true);
    expect(readRelayClientInstallPanelState()).toEqual({
      status: "installing",
      version: "2026.5.2",
      stage: "checking",
    });

    reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });
    expect(readRelayClientInstallPanelState()).toEqual({
      status: "installing",
      version: "2026.5.2",
      stage: "downloading",
    });

    finishRelayClientInstall();
    expect(readRelayClientInstallPanelState()).toEqual({
      status: "closing",
      view: {
        status: "installing",
        version: "2026.5.2",
        stage: "downloading",
      },
    });

    completeRelayClientInstallPanelClose();
    expect(readRelayClientInstallPanelState()).toEqual({ status: "idle" });
  });

  it("returns to idle when installation is declined", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.5.2");
    respondToRelayClientInstallConfirmation(false);

    await expect(confirmation).resolves.toBe(false);
    expect(readRelayClientInstallPanelState()).toEqual({
      status: "closing",
      view: {
        status: "confirming",
        version: "2026.5.2",
      },
    });

    completeRelayClientInstallPanelClose();
    expect(readRelayClientInstallPanelState()).toEqual({ status: "idle" });
  });

  it("rejects concurrent confirmation with the active install state", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.5.2");
    respondToRelayClientInstallConfirmation(true);
    await expect(confirmation).resolves.toBe(true);
    reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });

    const error = await requestRelayClientInstallConfirmation("2026.6.0").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RelayClientInstallConfirmationConflictError);
    expect(error).toMatchObject({
      requestedVersion: "2026.6.0",
      activeVersion: "2026.5.2",
      activeDialogStatus: "installing",
      activeInstallStage: "downloading",
    });
    expect(error).not.toHaveProperty("cause");
    expect((error as Error).message).toBe(
      "Cannot confirm relay client installation 2026.6.0; installation 2026.5.2 has dialog status installing.",
    );
  });
});
