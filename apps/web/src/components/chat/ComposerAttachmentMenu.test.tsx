import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";

describe("ComposerAttachmentMenu", () => {
  it("keeps one compact entry point for image uploads and project-file references", () => {
    const markup = renderToStaticMarkup(
      <ComposerAttachmentMenu onAttachImages={vi.fn()} onAddProjectFile={vi.fn()} />,
    );

    expect(markup).toContain('data-composer-attachment-menu="true"');
    expect(markup).toContain('aria-label="Add images or project files"');
    expect(markup).toContain('accept="image/*"');
    expect(markup).toContain('type="file"');
    expect(markup).toContain("multiple");
  });

  it("disables the attachment trigger while the composer cannot accept input", () => {
    const markup = renderToStaticMarkup(
      <ComposerAttachmentMenu disabled onAttachImages={vi.fn()} onAddProjectFile={vi.fn()} />,
    );

    expect(markup).toContain("disabled");
  });
});
