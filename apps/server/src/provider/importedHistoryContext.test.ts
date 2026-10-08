import {
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderImportedMessage,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildImportedHistoryPrompt,
  describeImportedHistoryFit,
} from "./importedHistoryContext.ts";

const message = (index: number, text: string): ProviderImportedMessage => ({
  id: MessageId.make(`source-${index}`),
  role: index % 2 === 0 ? "user" : "assistant",
  text,
});

describe("buildImportedHistoryPrompt", () => {
  it("sends the full history unchanged when it fits", () => {
    const fit = buildImportedHistoryPrompt([message(0, "short")], "Continue");
    expect(fit).toMatchObject({ fullCount: 1, excerptCount: 0, omittedCount: 0 });
    expect(fit?.prompt).not.toContain("condensed");
    expect(fit?.prompt).toContain("short");
    expect(describeImportedHistoryFit(fit!)).toBe("");
  });

  it("condenses oversized history into excerpts instead of refusing", () => {
    const history = Array.from({ length: 4 }, (_, index) => message(index, "x".repeat(60_000)));
    const fit = buildImportedHistoryPrompt(history, "Continue");
    expect(fit).toBeDefined();
    expect(fit!.prompt.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(fit!.prompt).toContain("condensed to fit");
    expect(fit!.prompt).toContain('"excerpt":true');
    expect(fit!.prompt.endsWith("Continue")).toBe(true);
    expect(fit!.fullCount + fit!.excerptCount + fit!.omittedCount).toBe(history.length);
    expect(describeImportedHistoryFit(fit!)).toContain("were not sent with this turn");
  });

  it("keeps the newest messages verbatim and drops the oldest first", () => {
    const history = Array.from({ length: 1_000 }, (_, index) =>
      message(index, `message-${index} ` + "y".repeat(2_000)),
    );
    const fit = buildImportedHistoryPrompt(history, "Continue", 120_000);
    expect(fit).toBeDefined();
    expect(fit!.prompt.length).toBeLessThanOrEqual(120_000);
    expect(fit!.prompt).toContain("message-999 " + "y".repeat(2_000));
    expect(fit!.prompt).not.toContain("message-0 ");
    expect(fit!.omittedCount).toBeGreaterThan(0);
  });

  it("keeps a newest message intact when it exceeds the preferred share but fits the prompt", () => {
    const latest = "latest-result " + "r".repeat(95_000);
    const fit = buildImportedHistoryPrompt(
      [message(0, "earlier-result " + "o".repeat(95_000)), message(1, latest)],
      "Continue",
    );
    expect(fit).toBeDefined();
    expect(fit!.prompt.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(fit!.prompt).toContain(latest);
    expect(fit).toMatchObject({ fullCount: 1, excerptCount: 1, omittedCount: 0 });
  });

  it("fails when the current request exceeds the continuation budget", () => {
    const fit = buildImportedHistoryPrompt([message(0, "context")], "z".repeat(200), 100);
    expect(fit).toBeUndefined();
  });
});
