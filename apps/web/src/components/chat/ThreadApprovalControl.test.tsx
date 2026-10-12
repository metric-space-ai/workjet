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
    expect(markup).toContain('value="project" selected');
    expect(markup).toContain("Freigabe nötig");
    const overridden = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="approval-required"
        projectRuntimeMode="auto"
        hasOwnWorktree
        onChange={async () => true}
      />,
    );
    expect(overridden).toContain('value="approval-required" selected');
  });
  it("caps project policy without a worktree and enables full access only with one", () => {
    const markup = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="auto-accept-edits"
        projectRuntimeMode="full-access"
        onChange={async () => true}
      />,
    );
    expect(markup).toContain('value="project" selected');
    expect(markup).toContain('value="full-access" disabled');
    expect(markup).toContain('value="auto" disabled');
    const isolated = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="full-access"
        projectRuntimeMode="full-access"
        hasOwnWorktree
        onChange={async () => true}
      />,
    );
    expect(isolated).toContain('value="project" selected');
    expect(isolated).not.toContain('value="full-access" disabled');
  });

  it("disables policy edits while the thread is unavailable", () => {
    expect(
      renderToStaticMarkup(
        <ThreadApprovalControl runtimeMode="full-access" disabled onChange={async () => true} />,
      ),
    ).toContain('disabled=""');
  });
});
