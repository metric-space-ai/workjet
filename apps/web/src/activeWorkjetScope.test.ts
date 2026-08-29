import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  __resetActiveWorkjetScopeForTests,
  applyActiveWorkjetHostSelectionAck,
  commitActiveWorkjetSelection,
  installActiveWorkjetSelectionAdapter,
  readActiveWorkjetScope,
  requestActiveWorkjetSelection,
  synchronizeActiveWorkjetMode,
} from "./activeWorkjetScope";

afterEach(() => __resetActiveWorkjetScopeForTests());

describe("ActiveWorkjetScope", () => {
  it("keeps mode and selected instance in one monotone snapshot", () => {
    expect(commitActiveWorkjetSelection("managed:welsch")).toBe(1);
    synchronizeActiveWorkjetMode("ctox");
    expect(readActiveWorkjetScope()).toEqual({
      mode: "ctox",
      selectedInstanceId: "managed:welsch",
      selectionRevision: 1,
    });
  });

  it("rejects stale and equal-revision conflicting native acknowledgements", () => {
    __resetActiveWorkjetScopeForTests({
      mode: "code",
      selectedInstanceId: "managed:welsch",
      selectionRevision: 7,
    });
    expect(
      applyActiveWorkjetHostSelectionAck({
        requestId: "request-old",
        selectedInstanceId: "managed:other",
        revision: 6,
      }),
    ).toBe(false);
    expect(
      applyActiveWorkjetHostSelectionAck({
        requestId: "request-conflict",
        selectedInstanceId: "managed:other",
        revision: 7,
      }),
    ).toBe(false);
    expect(readActiveWorkjetScope().selectedInstanceId).toBe("managed:welsch");
  });

  it("adopts only a newer persisted native selection", () => {
    expect(
      applyActiveWorkjetHostSelectionAck({
        requestId: "request-new",
        selectedInstanceId: "managed:welsch",
        revision: 3,
      }),
    ).toBe(true);
    expect(readActiveWorkjetScope()).toMatchObject({
      selectedInstanceId: "managed:welsch",
      selectionRevision: 3,
    });
  });

  it("does not optimistically switch before the native acknowledgement", async () => {
    let acknowledge: (() => void) | undefined;
    installActiveWorkjetSelectionAdapter(
      (request) =>
        new Promise((resolve) => {
          acknowledge = () =>
            resolve({
              requestId: request.requestId,
              selectedInstanceId: "managed:welsch",
              revision: request.expectedRevision + 1,
            });
        }),
    );

    const pending = requestActiveWorkjetSelection("managed:welsch");
    expect(readActiveWorkjetScope().selectedInstanceId).toBeNull();
    acknowledge?.();
    await expect(pending).resolves.toBe(true);
    expect(readActiveWorkjetScope().selectedInstanceId).toBe("managed:welsch");
  });
});
