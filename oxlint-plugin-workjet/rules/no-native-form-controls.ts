import { defineRule } from "@oxlint/plugins";

/**
 * UI rule 4 (#563): only styled controls. Native `<select>` and
 * `<input type="checkbox">` are replaced by `OptionSelect`/`Select`,
 * `Switch` or `Checkbox` from `components/ui/`.
 */

const normalizePath = (path: string) => path.replaceAll("\\", "/");

/**
 * Deliberate exceptions (#563): GFM task-list checkboxes inside rendered
 * Markdown, and a dev-only fixture page.
 */
const EXEMPT_FILES = [
  "apps/web/src/components/ChatMarkdown.tsx",
  "apps/web/src/fixtures/jour-fixe.fixture.tsx",
];

const isExempt = (filename: string) => {
  const path = normalizePath(filename);
  if (path.includes("/components/ui/")) return true; // the styled building blocks themselves
  if (/\.test\.tsx?$/u.test(path)) return true;
  return EXEMPT_FILES.some((pending) => path.endsWith(pending));
};

const elementName = (node: unknown): string | undefined => {
  if (typeof node !== "object" || node === null || !("name" in node)) return undefined;
  const name = node.name;
  if (typeof name !== "object" || name === null || !("type" in name)) return undefined;
  if (name.type !== "JSXIdentifier" || !("name" in name)) return undefined;
  return typeof name.name === "string" ? name.name : undefined;
};

const hasCheckboxType = (node: unknown): boolean => {
  if (typeof node !== "object" || node === null || !("attributes" in node)) return false;
  if (!Array.isArray(node.attributes)) return false;
  return node.attributes.some((attribute: unknown) => {
    if (typeof attribute !== "object" || attribute === null) return false;
    if (!("type" in attribute) || attribute.type !== "JSXAttribute") return false;
    if (!("name" in attribute) || elementName({ name: attribute.name }) !== "type") return false;
    if (!("value" in attribute)) return false;
    const value = attribute.value;
    return (
      typeof value === "object" && value !== null && "value" in value && value.value === "checkbox"
    );
  });
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow native <select> and checkbox inputs; use the styled controls from components/ui.",
    },
  },
  createOnce(context) {
    return {
      JSXOpeningElement(node) {
        if (isExempt(context.filename)) return;
        const name = elementName(node);
        if (name === "select") {
          context.report({
            node,
            message: "Use OptionSelect or Select from components/ui instead of a native <select>.",
          });
        } else if (name === "input" && hasCheckboxType(node)) {
          context.report({
            node,
            message:
              'Use Checkbox or Switch from components/ui instead of <input type="checkbox">.',
          });
        }
      },
    };
  },
});
