import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ThreadApprovalControl } from "./ThreadApprovalControl";

describe("thread approval policy control", () => {
  it("shows the project policy and an explicit approval override for a saved thread", () => {
    const markup = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="auto"
        projectRuntimeMode="auto"
        onChange={async () => true}
      />,
    );
    expect(markup).toContain('aria-label="Thread approval policy"');
    expect(markup).toContain('value="project" selected');
    expect(markup).toContain("Require approvals");
    const overridden = renderToStaticMarkup(
      <ThreadApprovalControl
        runtimeMode="approval-required"
        projectRuntimeMode="auto"
        onChange={async () => true}
      />,
    );
    expect(overridden).toContain('value="approval-required" selected');
  });
  it("disables policy edits while the thread is unavailable", () => {
    expect(
      renderToStaticMarkup(
        <ThreadApprovalControl runtimeMode="full-access" disabled onChange={async () => true} />,
      ),
    ).toContain('disabled=""');
  });
});
