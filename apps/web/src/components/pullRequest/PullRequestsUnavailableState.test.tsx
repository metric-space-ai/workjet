import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("PullRequestsUnavailableState", () => {
  it("zeigt einen nicht unterstützten Server ohne sinnlosen Wiederholversuch", () => {
    const text = textOf(
      PullRequestsUnavailableState({
        title: "Pull Requests nicht verfügbar",
        error: "CTOX-Server aktualisieren",
      }),
    );

    expect(text).toContain("Pull Requests nicht verfügbar");
    expect(text).toContain("CTOX-Server aktualisieren");
    expect(text).not.toContain("Erneut versuchen");
  });

  it("behält den Wiederholversuch für vorübergehende Fehler", () => {
    expect(
      textOf(PullRequestsUnavailableState({ error: "GitHub antwortet nicht.", onRetry: () => {} })),
    ).toContain("Erneut versuchen");
  });
});
