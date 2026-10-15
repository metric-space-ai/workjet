import { describe, expect, it } from "vite-plus/test";
import { subscribeConnectionCatalogWarning } from "./ConnectionCatalogWarning";

describe("saved connection catalog warning", () => {
  it("shows one non-blocking notice and releases its subscription", () => {
    let event: (() => void) | undefined;
    let notifications = 0;
    let subscriptions = 0;
    const unsubscribe = subscribeConnectionCatalogWarning(
      {
        onConnectionCatalogWarning: (listener) => {
          event = listener;
          subscriptions++;
          return () => {
            event = undefined;
            subscriptions--;
          };
        },
      },
      () => {
        notifications++;
      },
    );
    event?.();
    event?.();
    expect(notifications).toBe(1);
    unsubscribe?.();
    expect(subscriptions).toBe(0);
    expect(event).toBeUndefined();
  });
  it("leaves web and older desktop builds alone", () => {
    expect(
      subscribeConnectionCatalogWarning(undefined, () => {
        throw new Error("no desktop");
      }),
    ).toBeUndefined();
  });
});
