// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** A draft editor: changing focus or closing the popup never applies a model. */
export function ComposerCustomModelEditor({
  value,
  onChange,
  onApply,
  onDiscard,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onApply: (modelId: string) => void;
  readonly onDiscard: () => void;
}) {
  return (
    <form
      className="grid min-w-0 gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        // Popover portals remain children of the chat form in React's event tree.
        event.stopPropagation();
        const modelId = value.trim();
        if (modelId.length > 0) onApply(modelId);
      }}
    >
      <label className="grid min-w-0 gap-1.5 text-sm">
        Modell-ID
        <Input
          value={value}
          aria-label="Eigene Modell-ID"
          placeholder="Modell-ID"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDiscard}>
          Verwerfen
        </Button>
        <Button type="submit" disabled={value.trim().length === 0}>
          Modell verwenden
        </Button>
      </div>
    </form>
  );
}
