import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  providerDisplayName?: string | null;
}) {
  const { usage, providerDisplayName } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  const usageText =
    usage.maxTokens !== null && usedPercentage
      ? `${usedPercentage} · ${formatContextWindowTokens(usage.usedTokens)}/${formatContextWindowTokens(usage.maxTokens ?? null)}`
      : formatContextWindowTokens(usage.usedTokens);

  // Kein Popover: Ring und Zahl stehen inline, Details nur im Tooltip.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex h-7 items-center gap-1.5 text-muted-foreground"
            data-context-window-meter="true"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(normalizedPercentage)}
            aria-label={`Kontext ${usageText}`}
          />
        }
      >
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <svg
            viewBox="0 0 24 24"
            className="-rotate-90 absolute inset-0 size-full transform-gpu"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
              strokeWidth="3"
            />
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke={usageColor}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
            />
          </svg>
        </span>
        <span className="text-xs tabular-nums">{usageText}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="tabular-nums">
        {showTotalProcessed
          ? `Gesamt ${formatContextWindowTokens(totalProcessedTokens)}`
          : `Kontext ${usageText}`}
        {usage.compactsAutomatically
          ? ` · ${providerDisplayName ? `${providerDisplayName} komprimiert` : "komprimiert"} automatisch`
          : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
