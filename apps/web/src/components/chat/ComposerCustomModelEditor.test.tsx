// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerCustomModelEditor } from "./ComposerCustomModelEditor";

describe("custom model draft submission", () => {
  it("applies an arbitrary gateway model without submitting the enclosing chat", () => {
    const prevented: string[] = [];
    const apply = vi.fn((id: string) => {
      expect(prevented).toEqual(["default", "propagation"]);
      expect(id).toBe("CustomProvider/My-Model:2026");
    });
    const editor = ComposerCustomModelEditor({
      value: "  CustomProvider/My-Model:2026  ",
      onChange: vi.fn(),
      onApply: apply,
      onDiscard: vi.fn(),
    });

    editor.props.onSubmit({
      preventDefault: () => prevented.push("default"),
      stopPropagation: () => prevented.push("propagation"),
    } as unknown as FormEvent<HTMLFormElement>);

    expect(apply).toHaveBeenCalledExactlyOnceWith("CustomProvider/My-Model:2026");
  });

  it("blocks whitespace submissions even if the form is submitted without its disabled button", () => {
    const apply = vi.fn();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const editor = ComposerCustomModelEditor({
      value: " \t ",
      onChange: vi.fn(),
      onApply: apply,
      onDiscard: vi.fn(),
    });

    editor.props.onSubmit({
      preventDefault,
      stopPropagation,
    } as unknown as FormEvent<HTMLFormElement>);

    expect(apply).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("retains an unfinished draft with an explicit apply and discard choice", () => {
    const apply = vi.fn();
    const markup = renderToStaticMarkup(
      <ComposerCustomModelEditor
        value="UnlistedProvider/unfinished"
        onChange={vi.fn()}
        onApply={apply}
        onDiscard={vi.fn()}
      />,
    );

    expect(markup).toContain('value="UnlistedProvider/unfinished"');
    expect(markup).toContain("Use model");
    expect(markup).toContain("Discard");
    expect(apply).not.toHaveBeenCalled();
  });
});
