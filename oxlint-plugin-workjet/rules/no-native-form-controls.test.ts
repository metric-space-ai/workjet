import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("workjet/no-native-form-controls", {
  filename: "fixture.tsx",
});

describe("workjet/no-native-form-controls", () => {
  rule.valid(
    "allows styled controls and other inputs",
    `
      export const Row = () => (
        <div>
          <OptionSelect aria-label="Art" value="" options={[]} onValueChange={() => {}} />
          <Checkbox checked />
          <input type="text" />
        </div>
      );
    `,
  );

  rule.invalid(
    "reports a native select",
    `
      export const Row = () => (
        <select aria-label="Art">
          <option value="a">A</option>
        </select>
      );
    `,
    (output) => {
      assert.match(output, /OptionSelect or Select/);
    },
  );

  rule.invalid(
    "reports a native checkbox",
    `
      export const Row = () => <input type="checkbox" checked readOnly />;
    `,
    (output) => {
      assert.match(output, /Checkbox or Switch/);
    },
  );
});
