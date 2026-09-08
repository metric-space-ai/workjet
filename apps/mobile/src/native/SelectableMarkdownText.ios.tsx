import {
  SelectableMarkdownText as WorkjetSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@workjet/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@workjet/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <WorkjetSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
