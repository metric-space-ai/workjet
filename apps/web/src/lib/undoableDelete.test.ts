import { afterEach, describe, expect, it, vi } from "vitest";

const added: Array<{ actionProps?: { onClick: () => void } }> = [];
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: (toast: { actionProps?: { onClick: () => void } }) => added.push(toast) },
}));

import { scheduleUndoableDelete } from "./undoableDelete";

afterEach(() => {
  added.length = 0;
  vi.useRealTimers();
});

describe("scheduleUndoableDelete", () => {
  it("runs the delete after the undo window", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleUndoableDelete({ title: "x", undoLabel: "Rückgängig", run, delayMs: 1_000 });
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never runs when undo is pressed", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleUndoableDelete({ title: "x", undoLabel: "Rückgängig", run, delayMs: 1_000 });
    added[0]!.actionProps!.onClick();
    vi.advanceTimersByTime(5_000);
    expect(run).not.toHaveBeenCalled();
  });
});
