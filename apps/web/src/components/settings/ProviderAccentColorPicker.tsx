"use client";

import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ColorSelector } from "../color-selector";
import { Button } from "../ui/button";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { cn } from "../../lib/utils";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

const FALLBACK_ACCENT_COLOR = PROVIDER_ACCENT_SWATCHES[0];

/**
 * Eigene Farbe inline über das native Farbfeld statt eines Popovers mit
 * Farbfläche (drei Orte, keine Popups).
 */
function ProviderCustomColorInput(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly selected: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const normalized = normalizeProviderAccentColor(props.value) ?? FALLBACK_ACCENT_COLOR;
  return (
    <input
      type="color"
      value={normalized}
      onChange={(event) => props.onCommit(event.currentTarget.value)}
      className={cn(
        "size-6 shrink-0 cursor-pointer appearance-none overflow-hidden rounded-full border-0 bg-transparent p-0",
        "[&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0",
        !props.selected && "[&::-webkit-color-swatch]:opacity-0 [&::-moz-color-swatch]:opacity-0",
      )}
      // Without a custom colour the field must not look like the first
      // swatch (QA 0.0.95 E: two identical blue dots); it shows a colour wheel.
      style={
        props.selected
          ? { boxShadow: `inset 0 0 0 2px var(--card), 0 0 0 2px ${normalized}` }
          : {
              background:
                "conic-gradient(#dc2626, #ea580c, #eab308, #16a34a, #0891b2, #2563eb, #7c3aed, #dc2626)",
            }
      }
      data-custom-color={props.selected ? "" : undefined}
      aria-label={`Eigene Farbe für ${props.displayName}`}
    />
  );
}

export function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly commitDelayMs?: number;
}) {
  const { commitDelayMs = 0, displayName, onCommit, value } = props;
  const [optimisticValue, setOptimisticValue] = useState(() => value ?? "");
  const commitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    if (pendingCommitRef.current !== null) return;
    setOptimisticValue(value ?? "");
  }, [value]);

  useEffect(() => {
    return () => {
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }
      const pendingCommit = pendingCommitRef.current;
      if (pendingCommit !== null) {
        onCommitRef.current(pendingCommit);
      }
    };
  }, []);

  const commitAccentColor = useCallback(
    (value: string) => {
      const normalizedValue = normalizeProviderAccentColor(value) ?? "";
      setOptimisticValue(normalizedValue);

      if (commitDelayMs <= 0) {
        pendingCommitRef.current = null;
        if (commitTimeoutRef.current !== null) {
          clearTimeout(commitTimeoutRef.current);
          commitTimeoutRef.current = null;
        }
        onCommit(normalizedValue);
        return;
      }

      pendingCommitRef.current = normalizedValue;
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }
      commitTimeoutRef.current = setTimeout(() => {
        commitTimeoutRef.current = null;
        const pendingCommit = pendingCommitRef.current;
        pendingCommitRef.current = null;
        if (pendingCommit !== null) {
          onCommitRef.current(pendingCommit);
        }
      }, commitDelayMs);
    },
    [commitDelayMs, onCommit],
  );

  const normalized = normalizeProviderAccentColor(optimisticValue);
  const selectedValue =
    normalized &&
    PROVIDER_ACCENT_SWATCHES.includes(normalized as (typeof PROVIDER_ACCENT_SWATCHES)[number])
      ? normalized
      : "";
  const customSelected = Boolean(normalized && selectedValue === "");

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Farbe</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProviderCustomColorInput
          displayName={displayName}
          value={normalized}
          selected={customSelected}
          onCommit={commitAccentColor}
        />
        <ColorSelector
          key={selectedValue}
          colors={[...PROVIDER_ACCENT_SWATCHES]}
          defaultValue={selectedValue}
          size="lg"
          onColorSelect={commitAccentColor}
          className="flex-wrap gap-1.5"
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 shrink-0 text-muted-foreground transition-opacity",
            normalized ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={() => commitAccentColor("")}
          aria-label={`Farbe für ${displayName} entfernen`}
          title="Farbe entfernen"
          aria-hidden={!normalized}
          tabIndex={normalized ? 0 : -1}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
