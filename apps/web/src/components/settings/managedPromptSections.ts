// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The managed system prompt, split at its own headings so each part can be
 * read and edited on its own — without giving any part its own storage.
 *
 * ── Why split for display and not in the model ──────────────────────────────
 * The Swift Workjet settings page shows the prompt as named sections, each
 * with its own edit affordance: "Allgemeine Regeln", "Progress Board", the
 * per-model rules. Here the same text is deliberately ONE field. That is a
 * decision with a written reason (LegacyWorkjetMapping, the Progress board
 * arrives as `outcome: "mapped-into-prompt"`), and a second home for the same
 * content would give the importer two targets for one source.
 *
 * So the split is a VIEW. Sections are found by the markdown headings already
 * in the text, edited in place, and joined back into the one field. Nothing
 * about the stored shape changes, and a prompt with no headings at all is a
 * single section rather than an error — which is exactly what a hand-written
 * prompt looks like before anyone adds one.
 *
 * ── The rule that keeps this safe ───────────────────────────────────────────
 * Round-tripping must be byte-exact. Split then join, with no edit in between,
 * has to return the original string character for character — including
 * trailing whitespace and blank lines. A view that quietly reformats the
 * operator's prompt would corrupt the very thing it is meant to display, and
 * silently: nobody rereads a 6 KB prompt to check it survived.
 */

export interface ManagedPromptSection {
  /** Heading text without the leading `#`s, or `null` for a preamble. */
  readonly title: string | null;
  /** The heading line itself, kept verbatim so joining restores it exactly. */
  readonly headingLine: string | null;
  /**
   * Everything below the heading, up to the next one of the same level.
   *
   * Carried as LINES, not a joined string: a heading with nothing under it has
   * zero lines, while a heading followed by one blank line has one empty line.
   * A joined string cannot tell those apart, and guessing adds or drops a
   * newline on every round trip.
   */
  readonly bodyLines: ReadonlyArray<string>;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Split at the SHALLOWEST heading level present, so a prompt whose parts are
 * `##` is not shredded at every `###` beneath them. The operator's own
 * structure decides the granularity; picking a fixed level would split one
 * prompt too finely and another not at all.
 */
export function splitManagedPrompt(prompt: string): ReadonlyArray<ManagedPromptSection> {
  const lines = prompt.split("\n");
  let shallowest: number | null = null;
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match === null) continue;
    const level = match[1]!.length;
    if (shallowest === null || level < shallowest) shallowest = level;
  }
  if (shallowest === null) {
    return [{ title: null, headingLine: null, bodyLines: lines }];
  }

  const sections: ManagedPromptSection[] = [];
  let headingLine: string | null = null;
  let title: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (headingLine === null && buffer.length === 0) return;
    sections.push({ title, headingLine, bodyLines: buffer });
  };

  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match !== null && match[1]!.length === shallowest) {
      flush();
      headingLine = line;
      title = match[2]!.trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/**
 * Rejoin sections into the single stored field.
 *
 * `splitManagedPrompt` then `joinManagedPrompt` with no edit between must
 * return the input unchanged, byte for byte.
 */
export function joinManagedPrompt(sections: ReadonlyArray<ManagedPromptSection>): string {
  return sections
    .flatMap((section) =>
      section.headingLine === null
        ? [...section.bodyLines]
        : [section.headingLine, ...section.bodyLines],
    )
    .join("\n");
}

/** Replace one section's body, leaving every other byte alone. */
export function replaceSectionBody(
  sections: ReadonlyArray<ManagedPromptSection>,
  index: number,
  body: string,
): ReadonlyArray<ManagedPromptSection> {
  return sections.map((section, i) =>
    i === index ? { ...section, bodyLines: body.split("\n") } : section,
  );
}

/** The section's text, for an editor to show. */
export function sectionBody(section: ManagedPromptSection): string {
  return section.bodyLines.join("\n");
}
