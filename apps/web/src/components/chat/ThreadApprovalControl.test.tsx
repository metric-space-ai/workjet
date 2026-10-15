import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ThreadApprovalControl } from "./ThreadApprovalControl";

describe("thread approval policy control", () => {
  it("shows the project policy and an explicit approval override for a saved thread", () => {
    const markup = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="auto"
        projectRuntimeMode="auto"
        hasOwnWorktree
        onChange={async () => true}
      />,
    );
    expect(markup).toContain('aria-label="Freigaberegel"');
    expect(markup).toContain('data-value="project"');
    expect(markup).toContain("Freigabe nötig");
    const overridden = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="approval-required"
        projectRuntimeMode="auto"
        hasOwnWorktree
        onChange={async () => true}
      />,
    );
    expect(overridden).toContain('data-value="approval-required"');
  });
  it("caps project policy without a worktree and enables full access only with one", () => {
    const markup = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="auto-accept-edits"
        projectRuntimeMode="full-access"
        onChange={async () => true}
      />,
    );
    expect(markup).toContain('data-value="project"');
    expect(markup).toContain('data-option="full-access" data-disabled');
    expect(markup).toContain('data-option="auto" data-disabled');
    const isolated = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="full-access"
        projectRuntimeMode="full-access"
        hasOwnWorktree
        onChange={async () => true}
      />,
    );
    expect(isolated).toContain('data-value="project"');
    expect(isolated).not.toContain('data-option="full-access" data-disabled');
  });

  it("disables policy edits while the thread is unavailable", () => {
    expect(
      renderToStaticMarkup(
        <ThreadApprovalControl runtimeMode="full-access" disabled onChange={async () => true} />,
      ),
    ).toContain('disabled=""');
  });
});
