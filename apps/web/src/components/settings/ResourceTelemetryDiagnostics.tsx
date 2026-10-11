import {
  ActivityIcon,
  AlertTriangleIcon,
  BatteryIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  HardDriveIcon,
  MemoryStickIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import type {
  BackgroundBooleanState,
  ResourceAttributionEntry,
  ResourceTelemetryAggregate,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryIoSemantics,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
  ResourceTelemetryProcessSummary,
  ResourceTelemetrySourceHealth,
  ResourceTelemetrySourceStatus,
  ServerProcessSignal,
} from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@workjet/client-runtime/state/runtime";

import {
  useResourceTelemetry,
  useResourceTelemetryHistory,
} from "../../lib/resourceTelemetryState";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTime } from "../../timestampFormat";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  shouldShowResourceMonitorRetry,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value;
  let unitIndex = -1;
  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 100 ? 0 : next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatCpuTime(valueMs: number): string {
  const seconds = valueMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(2)} ms`;
  return `${(value / 1_000_000).toFixed(2)} s`;
}

function formatSampleInterval(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.max(0, Math.round(valueMs))} ms`;
  const seconds = valueMs / 1_000;
  return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${
    seconds === 1 ? "second" : "seconds"
  }`;
}

function processIdentityKey(process: ResourceTelemetryProcess): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function processSummaryIdentityKey(process: ResourceTelemetryProcessSummary): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function formatProcessName(process: Pick<ResourceTelemetryProcess, "command" | "name">): string {
  if (process.name.trim()) return process.name;
  const firstToken = process.command.trim().split(/\s+/)[0] ?? process.command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  return normalized.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? normalized;
}

function categoryLabel(category: ResourceTelemetryProcessCategory): string {
  switch (category) {
    case "server":
      return "Server";
    case "server-child":
      return "Backend-Kind";
    case "provider-root":
      return "Provider";
    case "terminal-root":
      return "Terminal";
    case "electron-main":
      return "Electron-Haupt";
    case "electron-renderer":
      return "Renderer";
    case "electron-gpu":
      return "GPU";
    case "electron-utility":
      return "Electron-Hilfe";
    case "resource-monitor":
      return "Monitor";
    case "unknown-workjet":
      return "Workjet-Prozess";
  }
}

function categoryDotClass(category: ResourceTelemetryProcessCategory): string {
  if (category === "resource-monitor") return "bg-amber-500";
  if (category.startsWith("electron-")) return "bg-sky-500";
  if (category === "server") return "bg-violet-500";
  return "bg-emerald-500";
}

function ioSemanticsLabel(semantics: ResourceTelemetryIoSemantics): string {
  switch (semantics) {
    case "storage":
      return "Speicher-Bytes";
    case "logical":
      return "Logische Bytes";
    case "all-io":
      return "Alle I/O-Bytes";
    case "unavailable":
      return "Unavailable";
  }
}

function booleanStateLabel(
  value: BackgroundBooleanState,
  labels: { readonly true: string; readonly false: string },
): string {
  if (value === "true") return labels.true;
  if (value === "false") return labels.false;
  return "Unknown";
}

function sourceStatusTone(status: ResourceTelemetrySourceStatus): "default" | "warning" | "danger" {
  if (status === "healthy") return "default";
  if (status === "starting" || status === "degraded") return "warning";
  return "danger";
}

function SourceStatusBadge({
  label,
  status,
  presentation,
}: {
  label: string;
  status: ResourceTelemetrySourceStatus;
  presentation?:
    | {
        readonly label: string;
        readonly tone: "neutral";
      }
    | undefined;
}) {
  const tone = presentation?.tone ?? sourceStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]",
        tone === "neutral" && "border-border/70 bg-muted/45 text-muted-foreground",
        tone === "default" &&
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "neutral" && "bg-muted-foreground/55",
          tone === "default" && "bg-emerald-500",
          tone === "warning" && "bg-amber-500",
          tone === "danger" && "bg-destructive",
        )}
      />
      {label} {presentation?.label ?? status}
    </span>
  );
}

function LastSampleLabel({ sampledAt }: { sampledAt: DateTime.Utc | null }) {
  useRelativeTimeTick();
  if (!sampledAt) {
    return <span className="text-[11px] text-muted-foreground/55">Wartet …</span>;
  }
  const relative = formatRelativeTime(DateTime.formatIso(sampledAt));
  if (!relative) {
    return <span className="text-[11px] text-muted-foreground/55">Wartet …</span>;
  }
  return (
    <span className="text-[11px] text-muted-foreground/60">
      {relative.suffix ? "Vor " : ""}
      <span className="font-mono tabular-nums">
        {relative.suffix ? relative.value : "gerade eben"}
      </span>
    </span>
  );
}

function IconStat({
  icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="group min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground/70">
        <span className="text-muted-foreground/55 transition-colors group-hover:text-foreground/65">
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <div
        className={cn(
          "mt-2.5 font-mono text-2xl font-semibold tracking-[-0.05em] tabular-nums text-foreground",
          tone === "warning" && "text-amber-600 dark:text-amber-300",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className="mt-1.5 text-[10px] leading-snug text-muted-foreground/60">{detail}</div>
      ) : null}
    </div>
  );
}

function AggregateCard({
  label,
  accentClass,
  aggregate,
}: {
  label: string;
  accentClass: string;
  aggregate: ResourceTelemetryAggregate;
}) {
  return (
    <div className="relative overflow-hidden border-t border-border/60 px-4 py-4 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0 sm:px-5">
      <span className={cn("absolute inset-x-5 top-0 h-0.5 rounded-full opacity-75", accentClass)} />
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground/75">
          {label}
        </div>
        <div className="rounded-md bg-muted/55 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-muted-foreground/70">
          {aggregate.processCount} {aggregate.processCount === 1 ? "process" : "processes"}
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <MetricPair label="CPU" value={`${aggregate.currentCpuPercent.toFixed(1)}%`} />
        <MetricPair label="Speicher" value={formatBytes(aggregate.currentRssBytes)} />
        <MetricPair label="Lesen" value={formatRate(aggregate.ioReadBytesPerSecond)} />
        <MetricPair label="Schreiben" value={formatRate(aggregate.ioWriteBytesPerSecond)} />
      </div>
    </div>
  );
}

function MetricPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/45">
        {label}
      </div>
      <div className="truncate font-mono text-xs font-medium tabular-nums text-foreground/90">
        {value}
      </div>
    </div>
  );
}

function HealthSource({ label, health }: { label: string; health: ResourceTelemetrySourceHealth }) {
  const expectedInBrowser =
    health.status === "unavailable" &&
    Option.exists(health.lastError, (error) => error.includes("'web' mode"));
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/50 py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground/65">
          {expectedInBrowser
            ? "Nur in der Desktop-App"
            : Option.match(health.lastError, {
                onNone: () => "Keine Fehler",
                onSome: (error) => error,
              })}
        </div>
      </div>
      <SourceStatusBadge
        label=""
        status={health.status}
        presentation={
          expectedInBrowser
            ? {
                label: "Nur Desktop",
                tone: "neutral",
              }
            : undefined
        }
      />
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0">
      <span className="text-[11px] text-muted-foreground/75">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-[11px] tabular-nums text-foreground/85",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function HistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border/60 p-0.5">
      {HISTORY_WINDOWS.map((option) => (
        <button
          key={option.windowMs}
          type="button"
          className={cn(
            "cursor-pointer h-6 rounded-sm px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground",
            selectedWindowMs === option.windowMs && "bg-muted text-foreground",
          )}
          onClick={() => onSelect(option.windowMs)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
}) {
  const maxCpu = resourceHistoryCpuScaleMax(buckets);
  const maxIo = Math.max(1, ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));

  return (
    <div className="border-t border-border/60 px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground/65">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> CPU Mittel
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-sky-500/70" /> I/O lesen
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-amber-500/80" /> I/O schreiben
        </span>
      </div>
      <div className="flex h-32 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 px-2 pt-3 pb-2">
        {buckets.map((bucket) => {
          const cpuHeight = resourceHistoryBarHeight({
            value: bucket.avgCpuPercent,
            max: maxCpu,
            minimumVisiblePercent: 2,
          });
          const readHeight = resourceHistoryBarHeight({
            value: bucket.ioReadBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          const writeHeight = resourceHistoryBarHeight({
            value: bucket.ioWriteBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="grid h-full min-w-1 flex-1 grid-cols-3 items-end gap-px">
                    <span
                      className="block rounded-t-sm bg-foreground/65"
                      style={{ height: `${cpuHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-sky-500/70"
                      style={{ height: `${readHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-amber-500/80"
                      style={{ height: `${writeHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" className="space-y-0.5 text-left">
                <div>CPU Mittel {bucket.avgCpuPercent.toFixed(1)} %</div>
                <div>CPU Spitze {bucket.maxCpuPercent.toFixed(1)} %</div>
                <div>Lesen {formatBytes(bucket.ioReadBytes)}</div>
                <div>Schreiben {formatBytes(bucket.ioWriteBytes)}</div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ProcessTreeName({
  process,
  collapsed,
  onToggle,
}: {
  process: ResourceTelemetryProcess;
  collapsed: boolean;
  onToggle: (process: ResourceTelemetryProcess) => void;
}) {
  const name = formatProcessName(process);
  const hasChildren = process.childPids.length > 0;
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 7) * 10}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="cursor-pointer inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onToggle(process)}
          aria-label={collapsed ? `${name} aufklappen` : `${name} zuklappen`}
        >
          <ChevronIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-5" aria-hidden />
      )}
      <span className={cn("size-1.5 rounded-full", categoryDotClass(process.category))} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px]"
        >
          {process.command || process.name}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function canSignalProcess(process: ResourceTelemetryProcess): boolean {
  return (
    process.category === "server-child" ||
    process.category === "provider-root" ||
    process.category === "terminal-root"
  );
}

function ProcessActions({
  process,
  signalingKeys,
  onSignal,
}: {
  process: ResourceTelemetryProcess;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  if (!canSignalProcess(process)) {
    return <span className="text-[10px] text-muted-foreground/35">—</span>;
  }
  const isSignaling = signalingKeys.has(processIdentityKey(process));
  return (
    <ProcessSignalButtons
      isSignaling={isSignaling}
      onInterrupt={() => onSignal(process, "SIGINT")}
      onKill={() => onSignal(process, "SIGKILL")}
    />
  );
}

/** INT und KILL als echte Buttons; KILL wird inline in der Zeile bestätigt. */
function ProcessSignalButtons({
  isSignaling,
  onInterrupt,
  onKill,
}: {
  isSignaling: boolean;
  onInterrupt: () => void;
  onKill: () => void;
}) {
  const [confirmingKill, setConfirmingKill] = useState(false);
  if (confirmingKill) {
    return (
      <div className="flex items-center justify-end gap-1" role="group">
        <Button
          size="xs"
          variant="destructive"
          disabled={isSignaling}
          onClick={() => {
            setConfirmingKill(false);
            onKill();
          }}
        >
          KILL?
        </Button>
        <Button size="xs" variant="outline" onClick={() => setConfirmingKill(false)}>
          Abbrechen
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="xs" variant="outline" disabled={isSignaling} onClick={onInterrupt}>
        INT
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={isSignaling}
        onClick={() => setConfirmingKill(true)}
      >
        KILL
      </Button>
    </div>
  );
}

function ProcessTable({
  processes,
  signalingKeys,
  onSignal,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcess>;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = useMemo(
    () => visibleResourceTelemetryProcesses(processes, collapsed),
    [collapsed, processes],
  );
  const toggle = useCallback((process: ResourceTelemetryProcess) => {
    const identityKey = processIdentityKey(process);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(identityKey)) {
        next.delete(identityKey);
      } else {
        next.add(identityKey);
      }
      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(68vh,48rem)] w-full max-w-full border-t border-border/60"
    >
      <table className="w-full min-w-[1320px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[10%]" />
          <col className="w-[7%]" />
          <col className="w-[8%]" />
          <col className="w-[9%]" />
          <col className="w-[9%]" />
          <col className="w-[9%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[6%]" />
          <col className="w-[4%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Prozess</th>
            <th className="px-3 py-2 font-semibold">Kategorie</th>
            <th className="px-3 py-2 text-right font-semibold">CPU</th>
            <th className="px-3 py-2 text-right font-semibold">CPU-Zeit</th>
            <th className="px-3 py-2 text-right font-semibold">Speicher</th>
            <th className="px-3 py-2 text-right font-semibold">Lesen/s</th>
            <th className="px-3 py-2 text-right font-semibold">Schreiben/s</th>
            <th className="px-3 py-2 text-right font-semibold">Lesen gesamt</th>
            <th className="px-3 py-2 text-right font-semibold">Schreiben gesamt</th>
            <th className="px-3 py-2 text-right font-semibold">PID</th>
            <th className="px-2 py-2 text-right font-semibold sm:pr-4">Signal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visible.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                Wartet auf Prozess-Monitor …
              </td>
            </tr>
          ) : null}
          {visible.map((process) => (
            <tr key={processIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <ProcessTreeName
                  process={process}
                  collapsed={collapsed.has(processIdentityKey(process))}
                  onToggle={toggle}
                />
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatBytes(process.residentBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatRate(process.ioReadBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatRate(process.ioWriteBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger render={<span>{formatBytes(process.ioWriteBytes)}</span>} />
                  <TooltipPopup side="top">{ioSemanticsLabel(process.ioSemantics)}</TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {process.identity.pid}
              </td>
              <td className="px-2 py-2 text-right sm:pr-4">
                <ProcessActions
                  process={process}
                  signalingKeys={signalingKeys}
                  onSignal={onSignal}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function HistoryProcessTable({
  processes,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcessSummary>;
}) {
  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[28rem] w-full max-w-full border-t border-border/60"
    >
      <table className="w-full min-w-[1020px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[7%]" />
          <col className="w-[5%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Prozess</th>
            <th className="px-3 py-2 font-semibold">Kategorie</th>
            <th className="px-3 py-2 text-right font-semibold">CPU-Zeit</th>
            <th className="px-3 py-2 text-right font-semibold">CPU Spitze</th>
            <th className="px-3 py-2 text-right font-semibold">Max. Speicher</th>
            <th className="px-3 py-2 text-right font-semibold">Lesen</th>
            <th className="px-3 py-2 text-right font-semibold">Schreiben</th>
            <th className="px-3 py-2 text-right font-semibold">Messpunkte</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                Keine Messpunkte im Zeitraum
              </td>
            </tr>
          ) : null}
          {processes.map((process) => (
            <tr key={processSummaryIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="block truncate font-medium text-foreground">
                        {process.name || process.command}
                      </span>
                    }
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px]"
                  >
                    {process.command || process.name}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {process.maxCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatBytes(process.peakRssBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatBytes(process.ioWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {process.sampleCount}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                {process.identity.pid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function AttributionTable({ entries }: { entries: ReadonlyArray<ResourceAttributionEntry> }) {
  return (
    <div className="overflow-x-auto border-t border-border/60">
      <table className="w-full min-w-[720px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[28%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[12%]" />
        </colgroup>
        <thead className="border-b border-border/60 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Komponente</th>
            <th className="px-3 py-2 font-semibold">Vorgang</th>
            <th className="px-3 py-2 text-right font-semibold">Log. Lesen</th>
            <th className="px-3 py-2 text-right font-semibold">Log. Schreiben</th>
            <th className="px-3 py-2 text-right font-semibold">Anzahl</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">Zeit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                Noch keine Anwendungs-I/O
              </td>
            </tr>
          ) : null}
          {entries.map((entry) => (
            <tr key={`${entry.component}:${entry.operation}`} className="hover:bg-muted/20">
              <td className="truncate px-4 py-2 font-medium text-foreground sm:pl-5">
                {entry.component}
              </td>
              <td className="truncate px-3 py-2 text-muted-foreground">{entry.operation}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatBytes(entry.logicalReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatBytes(entry.logicalWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{entry.count}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                {(entry.durationMs / 1_000).toFixed(2)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResourceTelemetryDiagnostics() {
  const [windowMs, setWindowMs] = useState(15 * 60_000);
  const selectedWindow =
    HISTORY_WINDOWS.find((option) => option.windowMs === windowMs) ?? HISTORY_WINDOWS[1];
  const telemetry = useResourceTelemetry();
  const retryTelemetry = telemetry.retry;
  const history = useResourceTelemetryHistory({
    windowMs: selectedWindow.windowMs,
    bucketMs: selectedWindow.bucketMs,
  });
  const primaryEnvironment = usePrimaryEnvironment();
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [signalingKeys, setSignalingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const signalingKeysRef = useRef<ReadonlySet<string>>(new Set());
  signalingKeysRef.current = signalingKeys;
  const primaryEnvironmentIdRef = useRef(primaryEnvironment?.environmentId);
  primaryEnvironmentIdRef.current = primaryEnvironment?.environmentId;
  const [isRetrying, setIsRetrying] = useState(false);
  const snapshot = telemetry.data;
  const allT3 = snapshot?.groups.allT3;

  const signalProcess = useCallback(
    async (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => {
      const identityKey = processIdentityKey(process);
      if (signalingKeysRef.current.has(identityKey)) return;
      const nextSignalingKeys = new Set(signalingKeysRef.current).add(identityKey);
      signalingKeysRef.current = nextSignalingKeys;
      setSignalingKeys(nextSignalingKeys);
      const clearSignaling = () => {
        const next = new Set(signalingKeysRef.current);
        next.delete(identityKey);
        signalingKeysRef.current = next;
        setSignalingKeys(next);
      };

      const environmentId = primaryEnvironmentIdRef.current;
      if (environmentId === undefined) {
        clearSignaling();
        return;
      }
      void signalServerProcess({
        environmentId,
        input: {
          pid: process.identity.pid,
          startTimeMs: process.identity.startTimeMs,
          signal,
        },
      })
        .then((result) => {
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return;
            throw squashAtomCommandFailure(result);
          }
          if (result.value.signaled) return;
          toastManager.add({
            type: "error",
            title: `${signal} nicht gesendet`,
            ...Option.match(result.value.message, {
              onNone: () => ({}),
              onSome: (message) => ({ description: message }),
            }),
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `${signal} nicht gesendet`,
            ...(error instanceof Error ? { description: error.message } : {}),
          });
        })
        .finally(() => {
          clearSignaling();
        });
    },
    [signalServerProcess],
  );

  const retryCollector = useCallback(() => {
    setIsRetrying(true);
    void retryTelemetry()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Monitor nicht neu gestartet",
          ...(error instanceof Error ? { description: error.message } : {}),
        });
      })
      .finally(() => {
        setIsRetrying(false);
      });
  }, [retryTelemetry]);

  const speedLimit = snapshot ? Option.getOrNull(snapshot.speedLimitPercent) : null;
  const collectorNeedsRetry = shouldShowResourceMonitorRetry({
    nativeStatus: snapshot?.health.native.status ?? null,
    error: telemetry.error,
  });
  const hasHostPowerSignal =
    snapshot !== null &&
    (snapshot.power.onBattery !== "unknown" ||
      snapshot.power.lowPowerMode !== "unknown" ||
      snapshot.power.idle !== "unknown" ||
      snapshot.power.locked !== "unknown" ||
      snapshot.power.thermalState !== "unknown");

  return (
    <>
      <SettingsSection
        title="Ressourcen"
        icon={<ActivityIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex items-center gap-2">
            {snapshot ? (
              <SourceStatusBadge label="Native" status={snapshot.health.native.status} />
            ) : null}
            <LastSampleLabel sampledAt={snapshot?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0"
                    disabled={telemetry.isPending}
                    onClick={telemetry.refresh}
                    aria-label="Ressourcen aktualisieren"
                  >
                    <RefreshCwIcon
                      className={cn("size-3", telemetry.isPending && "animate-spin")}
                    />
                  </Button>
                }
              />
              <TooltipPopup side="top">Aktualisieren</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="@container/resource-telemetry overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_1px_rgb(0_0_0/0.03),0_8px_30px_rgb(0_0_0/0.035)]">
          <div className="flex flex-col gap-3 border-b border-border/60 bg-linear-to-r from-muted/45 via-muted/20 to-transparent px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
              Workjet gesamt
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground/65">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Alle {snapshot ? formatSampleInterval(snapshot.sampleIntervalMs) : "…"}
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-border/55 @[46rem]/resource-telemetry:grid-cols-3">
            <IconStat
              icon={<CpuIcon className="size-3.5" />}
              label="CPU aktuell"
              value={allT3 ? `${allT3.currentCpuPercent.toFixed(1)}%` : "..."}
              detail={allT3 ? `${formatCpuTime(allT3.cpuTimeMs)} CPU-Zeit` : undefined}
            />
            <IconStat
              icon={<MemoryStickIcon className="size-3.5" />}
              label="Speicher"
              value={allT3 ? formatBytes(allT3.currentRssBytes) : "..."}
              detail={
                allT3 ? `${formatBytes(allT3.peakRssBytes)} Spitzen gesamt` : undefined
              }
            />
            <IconStat
              icon={<ActivityIcon className="size-3.5" />}
              label="Prozesse"
              value={allT3 ? String(allT3.processCount) : "..."}
              detail={
                allT3 ? `${allT3.processStarts} Starts · ${allT3.processExits} Enden` : undefined
              }
            />
            <IconStat
              icon={<HardDriveIcon className="size-3.5" />}
              label="Lesen"
              value={allT3 ? formatRate(allT3.ioReadBytesPerSecond) : "..."}
              detail={allT3 ? `${formatBytes(allT3.ioReadBytes)} gesamt` : undefined}
            />
            <IconStat
              icon={<DatabaseIcon className="size-3.5" />}
              label="Schreiben"
              value={allT3 ? formatRate(allT3.ioWriteBytesPerSecond) : "..."}
              detail={allT3 ? `${formatBytes(allT3.ioWriteBytes)} gesamt` : undefined}
              tone={
                allT3 && allT3.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024
                  ? "danger"
                  : allT3 && allT3.ioWriteBytesPerSecond >= 1_024 * 1_024
                    ? "warning"
                    : "default"
              }
            />
            <IconStat
              icon={<GaugeIcon className="size-3.5" />}
              label="CPU-Drossel"
              value={
                snapshot ? (speedLimit === null ? "Unknown" : `${speedLimit.toFixed(0)}%`) : "..."
              }
              detail={snapshot ? `${snapshot.power.thermalState}` : undefined}
              tone={speedLimit !== null && speedLimit < 80 ? "warning" : "default"}
            />
          </div>
          {telemetry.error ? (
            <div className="flex items-start gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:px-5">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{telemetry.error}</span>
            </div>
          ) : null}
          {snapshot ? (
            <div className="grid border-t border-border/60 bg-muted/10 @[46rem]/resource-telemetry:grid-cols-3">
              <AggregateCard
                label="Backend + Lumas"
                accentClass="bg-emerald-500/80"
                aggregate={snapshot.groups.backend}
              />
              <AggregateCard
                label="Desktop"
                accentClass="bg-sky-500/80"
                aggregate={snapshot.groups.electron}
              />
              <AggregateCard
                label="Monitor-Last"
                accentClass="bg-amber-500/80"
                aggregate={snapshot.groups.monitor}
              />
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Host und Erfassung"
        icon={<GaugeIcon className="size-4 text-muted-foreground" />}
        headerAction={
          collectorNeedsRetry ? (
            <Button size="xs" variant="outline" disabled={isRetrying} onClick={retryCollector}>
              <RotateCcwIcon className={cn("size-3", isRetrying && "animate-spin")} />
              Erneut versuchen
            </Button>
          ) : null
        }
      >
        <div className="grid overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_1px_rgb(0_0_0/0.03)] md:grid-cols-2 md:divide-x md:divide-border/60">
          <div className="px-4 py-4 sm:px-5">
            <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <BatteryIcon className="size-3.5" />
              </span>
              Host-Zustand
            </div>
            {hasHostPowerSignal && snapshot ? (
              <>
                <DetailRow
                  label="Stromquelle"
                  value={booleanStateLabel(snapshot.power.onBattery, {
                    true: "Battery",
                    false: "Netzteil",
                  })}
                />
                <DetailRow
                  label="Energiesparen"
                  value={booleanStateLabel(snapshot.power.lowPowerMode, {
                    true: "Enabled",
                    false: "Disabled",
                  })}
                />
                <DetailRow
                  label="Leerlauf"
                  value={`${booleanStateLabel(snapshot.power.idle, {
                    true: "Idle",
                    false: "Active",
                  })}${
                    snapshot.power.idleSeconds === null
                      ? ""
                      : ` · ${Math.round(snapshot.power.idleSeconds)}s`
                  }`}
                />
                <DetailRow
                  label="Sitzung"
                  value={
                    snapshot.power.suspended
                      ? "Suspended"
                      : booleanStateLabel(snapshot.power.locked, {
                          true: "Locked",
                          false: "Unlocked",
                        })
                  }
                />
                <DetailRow
                  label="Thermal"
                  value={snapshot.power.thermalState}
                  valueClassName={
                    snapshot.power.thermalState === "serious" ||
                    snapshot.power.thermalState === "critical"
                      ? "text-destructive"
                      : undefined
                  }
                />
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-5">
                <div className="text-[13px] font-medium text-foreground">
                  Desktop-Signale nicht verbunden
                </div>
                <p className="mt-1.5 max-w-sm text-[11px] leading-relaxed text-muted-foreground/70">
                  Power, idle, lock, and thermal state are supplied by the desktop host. Process
                  telemetry remains fully active in this browser session.
                </p>
              </div>
            )}
          </div>
          <div className="border-t border-border/60 px-4 py-4 md:border-t-0 sm:px-5">
            <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <GaugeIcon className="size-3.5" />
              </span>
              Erfassung
            </div>
            {snapshot ? (
              <>
                <HealthSource label="Prozess-Monitor" health={snapshot.health.native} />
                <HealthSource label="Electron-Hauptprozess" health={snapshot.health.desktop} />
                <DetailRow
                  label="Erfassungszeit"
                  value={formatDurationMicros(snapshot.health.collectionDurationMicros)}
                />
                <DetailRow
                  label="Prozess-Scan"
                  value={`${snapshot.health.retainedProcessCount}/${snapshot.health.scannedProcessCount} behalten`}
                />
                <DetailRow
                  label="Unzugänglich"
                  value={String(snapshot.health.inaccessibleProcessCount)}
                  valueClassName={
                    snapshot.health.inaccessibleProcessCount > 0
                      ? "text-amber-600 dark:text-amber-300"
                      : undefined
                  }
                />
                <DetailRow
                  label="Sidecar"
                  value={Option.match(snapshot.health.sidecarVersion, {
                    onNone: () => "Unavailable",
                    onSome: (version) =>
                      `${version}${Option.match(snapshot.health.sidecarPid, {
                        onNone: () => "",
                        onSome: (pid) => ` · PID ${pid}`,
                      })}`,
                  })}
                />
                <DetailRow label="Neustarts" value={String(snapshot.health.restartCount)} />
              </>
            ) : (
              <div className="py-4 text-xs text-muted-foreground">
                Wartet auf Erfassung …
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Ressourcenverlauf"
        icon={<HardDriveIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex items-center gap-2">
            <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0"
              disabled={history.isPending}
              onClick={history.refresh}
              aria-label="Verlauf aktualisieren"
            >
              <RefreshCwIcon className={cn("size-3", history.isPending && "animate-spin")} />
            </Button>
          </div>
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_1px_rgb(0_0_0/0.03)]">
          {history.error ? (
            <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:px-5">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{history.error}</span>
            </div>
          ) : null}
          <ResourceHistoryChart buckets={history.data?.buckets ?? []} />
          <HistoryProcessTable processes={history.data?.topProcesses ?? []} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Prozessbaum"
        icon={<CpuIcon className="size-4 text-muted-foreground" />}
        headerAction={
          snapshot ? (
            <span className="text-[10px] text-muted-foreground/55">
              Kennung: <span className="font-mono">PID + Startzeit</span>
            </span>
          ) : null
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_1px_rgb(0_0_0/0.03)]">
          <ProcessTable
            processes={snapshot?.processes ?? []}
            signalingKeys={signalingKeys}
            onSignal={signalProcess}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Anwendungs-I/O"
        icon={<DatabaseIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <span className="text-[10px] text-muted-foreground/55">Logische Bytes je Vorgang</span>
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_1px_rgb(0_0_0/0.03)]">
          <div className="bg-muted/15 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
            Native counters identify which process is reading or writing. These application-level
            counters identify known Workjet operations so process spikes can be correlated with
            specific persistence and logging paths.
          </div>
          <AttributionTable entries={snapshot?.attribution.entries ?? []} />
        </div>
      </SettingsSection>
    </>
  );
}
