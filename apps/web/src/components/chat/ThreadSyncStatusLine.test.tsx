import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusLine } from "./ThreadSyncStatusLine";

describe("ThreadSyncStatusLine", () => {
  it("stays silent while loading", () => {
    const markup = renderToStaticMarkup(
      <ThreadSyncStatusLine phase="loading" onRetry={() => {}} />,
    );
    expect(markup).toBe("");
  });

  it("shows one German line with one retry action after the notice delay", () => {
    const markup = renderToStaticMarkup(
      <ThreadSyncStatusLine phase="syncing" onRetry={() => {}} initiallySlow />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Nachrichten nicht geladen");
    expect(markup).toContain("Erneut versuchen");
    expect(markup).not.toContain("messages");
    expect(markup).not.toContain("rounded-full");
  });
});
