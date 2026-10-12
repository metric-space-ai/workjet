import type { DesktopPendingDeepLink } from "@workjet/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { InlineConfirmBarProps } from "../InlineNoticeSlot";
import { DeepLinkConfirmationPrompt, describeDeepLinkTarget } from "./DeepLinkConfirmationNotice";

const link: DesktopPendingDeepLink = {
  linkId: "deep-link-1",
  scheme: "ctox-desktop",
  canonicalUrl: "workjet://app/threads/abc?tab=diff",
  path: "/threads/abc",
  search: "?tab=diff",
  hash: "",
};

describe("DeepLinkConfirmationPrompt", () => {
  it("names the target as a place, never as a raw URL", () => {
    expect(describeDeepLinkTarget("/")).toBe("Projekte");
    expect(describeDeepLinkTarget("/settings/usage")).toBe("Einstellungen");
    expect(describeDeepLinkTarget("/pull-requests")).toBe("Pull Requests");
    expect(describeDeepLinkTarget("/draft/abc")).toBe("Neue Unterhaltung");
    expect(describeDeepLinkTarget("/env-1/thread-1")).toBe("Unterhaltung");
  });

  it("asks inline (no modal) and shows the target place the confirmation applies to", () => {
    const markup = renderToStaticMarkup(
      <DeepLinkConfirmationPrompt
        link={link}
        onConfirm={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(markup).toContain("data-deep-link-confirmation");
    expect(markup).toContain("Externen Link öffnen?");
    expect(markup).toMatch(/data-deep-link-target[^>]*>Unterhaltung</);
    expect(markup).not.toContain("workjet://");
    expect(markup).toContain(">Öffnen<");
    expect(markup).toContain(">Abbrechen<");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('role="alertdialog"');
    expect(markup).not.toContain("aria-modal");
  });

  it("navigates through the supplied callback only when the user confirms", () => {
    const navigated: string[] = [];
    const dismissed: string[] = [];
    const element = DeepLinkConfirmationPrompt({
      link,
      onConfirm: () => navigated.push(link.canonicalUrl),
      onDismiss: () => dismissed.push(link.linkId),
    }) as ReactElement<InlineConfirmBarProps>;

    element.props.onCancel();
    expect(navigated).toEqual([]);
    expect(dismissed).toEqual([link.linkId]);

    element.props.onConfirm();
    expect(navigated).toEqual([link.canonicalUrl]);
  });
});
