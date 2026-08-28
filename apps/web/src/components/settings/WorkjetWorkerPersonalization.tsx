import type { WorkjetWorkerPersonalization } from "@t3tools/contracts";
import {
  ArrowLeftRightIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const weightToSlider = (weight: number) => Math.round((Math.max(-1, Math.min(1, weight)) + 1) * 50);
const sliderToWeight = (value: number) => Math.max(-1, Math.min(1, (value - 50) / 50));

interface MutableAxis {
  id: string;
  left: string;
  right: string;
  value: number;
}

interface MutableGroup {
  id: string;
  title: string;
  meta: MutableAxis;
  details: MutableAxis[];
}

interface MutablePersonalization {
  enabled: boolean;
  groups: MutableGroup[];
  metaToDetailWeights: number[][];
  detailInfluenceWeights: number[][];
}

function clonePersonalization(value: WorkjetWorkerPersonalization): MutablePersonalization {
  return {
    ...value,
    groups: value.groups.map((group) => ({
      ...group,
      meta: { ...group.meta },
      details: group.details.map((detail) => ({ ...detail })),
    })),
    metaToDetailWeights: value.metaToDetailWeights.map((row) => [...row]),
    detailInfluenceWeights: value.detailInfluenceWeights.map((row) => [...row]),
  };
}

function flattenDetails(value: WorkjetWorkerPersonalization) {
  return value.groups.flatMap((group, groupIndex) =>
    group.details.map((detail, detailIndex) => ({
      detail,
      group,
      groupIndex,
      detailIndex,
    })),
  );
}

function flattenMutableDetails(value: MutablePersonalization) {
  return value.groups.flatMap((group, groupIndex) =>
    group.details.map((detail, detailIndex) => ({
      detail,
      group,
      groupIndex,
      detailIndex,
    })),
  );
}

export function parseWorkjetPersonalizationMatrices(
  matrixW: string,
  matrixA: string,
  detailCount: number,
  groupCount: number,
): Pick<WorkjetWorkerPersonalization, "metaToDetailWeights" | "detailInfluenceWeights"> {
  const w = JSON.parse(matrixW) as unknown;
  const a = JSON.parse(matrixA) as unknown;
  const validWeight = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) && entry >= -1 && entry <= 1;
  if (
    !Array.isArray(w) ||
    w.length !== detailCount ||
    w.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== groupCount ||
        row.some((entry) => !validWeight(entry)),
    )
  ) {
    throw new Error(
      `W must be ${String(detailCount)} × ${String(groupCount)} with weights from -1 to 1.`,
    );
  }
  if (
    !Array.isArray(a) ||
    a.length !== detailCount ||
    a.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== detailCount ||
        row.some((entry) => !validWeight(entry)),
    )
  ) {
    throw new Error(
      `A must be ${String(detailCount)} × ${String(detailCount)} with weights from -1 to 1.`,
    );
  }
  return {
    metaToDetailWeights: w as number[][],
    detailInfluenceWeights: a as number[][],
  };
}

function recomputeMetaValues(value: MutablePersonalization) {
  const flat = flattenMutableDetails(value);
  value.groups.forEach((group, metaIndex) => {
    let numerator = 0;
    let denominator = 0;
    flat.forEach(({ detail }, detailIndex) => {
      const weight = value.metaToDetailWeights[detailIndex]?.[metaIndex] ?? 0;
      numerator += weight * (detail.value - 50);
      denominator += Math.abs(weight);
    });
    group.meta.value = clamp(50 + (denominator === 0 ? 0 : numerator / denominator));
  });
}

interface AxisEditorState {
  readonly groupId: string;
  readonly axisId: string | null;
  readonly left: string;
  readonly right: string;
}

export function WorkjetWorkerPersonalizationEditor({
  value,
  onChange,
}: {
  readonly value: WorkjetWorkerPersonalization;
  readonly onChange: (value: WorkjetWorkerPersonalization) => void;
}) {
  const [visibleGroups, setVisibleGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [customizing, setCustomizing] = useState(false);
  const [editing, setEditing] = useState<AxisEditorState | null>(null);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [weightDirection, setWeightDirection] = useState<"to-target" | "from-target">("to-target");
  const [showMatrices, setShowMatrices] = useState(false);
  const [matrixW, setMatrixW] = useState("");
  const [matrixA, setMatrixA] = useState("");
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const flat = useMemo(() => flattenDetails(value), [value]);
  const activeTargetIndex = flat.findIndex(({ detail }) => detail.id === activeTargetId);

  const updateMeta = (groupIndex: number, nextValue: number) => {
    const next = clonePersonalization(value);
    const previousValue = next.groups[groupIndex]?.meta.value ?? 50;
    const delta = clamp(nextValue) - previousValue;
    const group = next.groups[groupIndex];
    if (group === undefined) return;
    group.meta.value = clamp(nextValue);
    flattenMutableDetails(next).forEach(({ detail }, detailIndex) => {
      detail.value = clamp(
        detail.value + (next.metaToDetailWeights[detailIndex]?.[groupIndex] ?? 0) * delta,
      );
    });
    onChange(next);
  };

  const updateDetail = (detailIndex: number, sliderValue: number) => {
    const next = clonePersonalization(value);
    if (activeTargetIndex >= 0 && activeTargetIndex !== detailIndex) {
      const weight = sliderToWeight(sliderValue);
      if (weightDirection === "to-target") {
        const row = next.detailInfluenceWeights[detailIndex];
        if (row !== undefined) row[activeTargetIndex] = weight;
      } else {
        const row = next.detailInfluenceWeights[activeTargetIndex];
        if (row !== undefined) row[detailIndex] = weight;
      }
      onChange(next);
      return;
    }
    const nextFlat = flattenMutableDetails(next);
    const source = nextFlat[detailIndex]?.detail;
    if (source === undefined) return;
    const normalized = clamp(sliderValue);
    const delta = normalized - source.value;
    source.value = normalized;
    nextFlat.forEach(({ detail }, index) => {
      if (index === detailIndex) return;
      detail.value = clamp(
        detail.value + (next.detailInfluenceWeights[detailIndex]?.[index] ?? 0) * delta,
      );
    });
    recomputeMetaValues(next);
    onChange(next);
  };

  const saveAxis = () => {
    if (editing === null || editing.left.trim() === "" || editing.right.trim() === "") return;
    const next = clonePersonalization(value);
    const groupIndex = next.groups.findIndex((group) => group.id === editing.groupId);
    const group = next.groups[groupIndex];
    if (group === undefined) return;
    if (editing.axisId !== null) {
      const detail = group.details.find((candidate) => candidate.id === editing.axisId);
      if (detail !== undefined) {
        detail.left = editing.left.trim();
        detail.right = editing.right.trim();
      }
    } else {
      const detailId = `custom-${Date.now().toString(36)}`;
      const insertionIndex =
        next.groups
          .slice(0, groupIndex)
          .reduce((sum, candidate) => sum + candidate.details.length, 0) + group.details.length;
      group.details.push({
        id: detailId,
        left: editing.left.trim(),
        right: editing.right.trim(),
        value: 50,
      });
      const metaWeights = next.groups.map((_, index) => (index === groupIndex ? 1 : 0));
      next.metaToDetailWeights.splice(insertionIndex, 0, metaWeights);
      next.detailInfluenceWeights.forEach((row) => row.splice(insertionIndex, 0, 0));
      next.detailInfluenceWeights.splice(
        insertionIndex,
        0,
        Array.from({ length: next.detailInfluenceWeights.length + 1 }, () => 0),
      );
    }
    setEditing(null);
    setActiveTargetId(null);
    onChange(next);
  };

  const removeAxis = (axisId: string) => {
    const detailIndex = flat.findIndex(({ detail }) => detail.id === axisId);
    if (detailIndex < 0) return;
    const next = clonePersonalization(value);
    next.groups = next.groups.map((group) => ({
      ...group,
      details: group.details.filter((detail) => detail.id !== axisId),
    }));
    next.metaToDetailWeights.splice(detailIndex, 1);
    next.detailInfluenceWeights.splice(detailIndex, 1);
    next.detailInfluenceWeights.forEach((row) => row.splice(detailIndex, 1));
    if (activeTargetId === axisId) setActiveTargetId(null);
    onChange(next);
  };

  const openMatrices = () => {
    setMatrixW(JSON.stringify(value.metaToDetailWeights, null, 2));
    setMatrixA(JSON.stringify(value.detailInfluenceWeights, null, 2));
    setMatrixError(null);
    setShowMatrices(true);
  };

  const applyMatrices = () => {
    try {
      const matrices = parseWorkjetPersonalizationMatrices(
        matrixW,
        matrixA,
        flat.length,
        value.groups.length,
      );
      onChange({
        ...clonePersonalization(value),
        ...matrices,
      });
      setShowMatrices(false);
    } catch (cause) {
      setMatrixError(cause instanceof Error ? cause.message : "Invalid matrices.");
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-background/20">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2.5">
        <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Profile
        </h4>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Personalization
          <Switch
            checked={value.enabled}
            onCheckedChange={(enabled) => onChange({ ...value, enabled: Boolean(enabled) })}
            aria-label="Enable worker personalization"
          />
        </label>
      </div>

      <div className={cn("divide-y divide-border/50", !value.enabled && "opacity-40")}>
        {value.groups.map((group, groupIndex) => {
          const visible = visibleGroups.has(group.id);
          return (
            <div
              key={group.id}
              className="grid min-h-16 grid-cols-[minmax(8rem,1fr)_minmax(12rem,1.5fr)_minmax(8rem,1fr)_1.75rem] items-center gap-3 px-3 py-2"
            >
              <span className="text-xs font-medium leading-tight">{group.meta.left}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={group.meta.value}
                disabled={!value.enabled || activeTargetIndex >= 0}
                onChange={(event) => updateMeta(groupIndex, Number(event.target.value))}
                aria-label={`${group.meta.left} to ${group.meta.right}`}
                className="h-5 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
              />
              <span className="text-right text-xs font-medium leading-tight">
                {group.meta.right}
              </span>
              <button
                type="button"
                disabled={!value.enabled}
                aria-expanded={visible}
                aria-label={`${visible ? "Hide" : "Show"} ${group.title}`}
                onClick={() =>
                  setVisibleGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
                className={cn(
                  "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  visible && "bg-primary/10 text-primary",
                )}
              >
                <ChevronRightIcon
                  className={cn("size-3.5 transition-transform", visible && "rotate-90")}
                />
              </button>
            </div>
          );
        })}
      </div>

      {value.enabled && visibleGroups.size > 0 ? (
        <div className="border-t border-border/50 p-3">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Details
            </h4>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant={customizing ? "outline" : "ghost"}
                onClick={() => {
                  setCustomizing((current) => !current);
                  setActiveTargetId(null);
                }}
              >
                Customize
              </Button>
              {customizing ? (
                <Button type="button" size="xs" variant="ghost" onClick={openMatrices}>
                  W/A
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setVisibleGroups(new Set());
                  setActiveTargetId(null);
                }}
              >
                Hide all
              </Button>
            </div>
          </div>

          {activeTargetIndex >= 0 ? (
            <div className="mb-2.5 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-600 dark:text-amber-300">
              <span className="font-medium">
                {flat[activeTargetIndex]?.detail.left} ↔ {flat[activeTargetIndex]?.detail.right}
              </span>
              <span className="ml-auto">Direction</span>
              <select
                value={weightDirection}
                onChange={(event) =>
                  setWeightDirection(event.target.value as "to-target" | "from-target")
                }
                className="rounded-md border border-border/70 bg-background px-2 py-1 text-foreground"
              >
                <option value="to-target">Others → target</option>
                <option value="from-target">Target → others</option>
              </select>
              <button
                type="button"
                aria-label="Close weighting mode"
                onClick={() => setActiveTargetId(null)}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ) : null}

          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] items-start gap-2.5">
            {value.groups
              .filter((group) => visibleGroups.has(group.id))
              .map((group) => (
                <section
                  key={group.id}
                  className="overflow-hidden rounded-lg border border-border/60"
                >
                  <header className="flex min-h-10 items-center justify-between border-b border-border/50 px-2.5">
                    <h5 className="text-xs font-medium">{group.title}</h5>
                    <div className="flex items-center gap-1">
                      {customizing ? (
                        <button
                          type="button"
                          aria-label={`Add detail slider to ${group.title}`}
                          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          onClick={() =>
                            setEditing({ groupId: group.id, axisId: null, left: "", right: "" })
                          }
                        >
                          <PlusIcon className="size-3.5" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Hide ${group.title}`}
                        className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        onClick={() =>
                          setVisibleGroups((current) => {
                            const next = new Set(current);
                            next.delete(group.id);
                            return next;
                          })
                        }
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </div>
                  </header>

                  {flat
                    .map((entry, detailIndex) => ({ ...entry, detailIndex }))
                    .filter((entry) => entry.group.id === group.id)
                    .map(({ detail, detailIndex }) => {
                      const isTarget = detailIndex === activeTargetIndex;
                      const isWeight = activeTargetIndex >= 0 && !isTarget;
                      const influence =
                        weightDirection === "to-target"
                          ? (value.detailInfluenceWeights[detailIndex]?.[activeTargetIndex] ?? 0)
                          : (value.detailInfluenceWeights[activeTargetIndex]?.[detailIndex] ?? 0);
                      const sliderValue = isWeight ? weightToSlider(influence) : detail.value;
                      return (
                        <div
                          key={detail.id}
                          className={cn(
                            "group/detail border-b border-border/50 px-2.5 py-2.5 last:border-b-0",
                            isTarget && "bg-primary/10",
                            isWeight && "bg-amber-500/[0.035]",
                          )}
                        >
                          <div className="mb-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-1.5">
                            <span className="text-[11px] font-medium leading-tight">
                              {detail.left}
                            </span>
                            {customizing ? (
                              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/detail:opacity-100 group-hover/detail:opacity-100">
                                <button
                                  type="button"
                                  aria-label={`Edit weighting for ${detail.left} to ${detail.right}`}
                                  onClick={() =>
                                    setActiveTargetId((current) =>
                                      current === detail.id ? null : detail.id,
                                    )
                                  }
                                  className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                >
                                  <ArrowLeftRightIcon className="size-3" />
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Edit detail slider ${detail.left} to ${detail.right}`}
                                  onClick={() =>
                                    setEditing({
                                      groupId: group.id,
                                      axisId: detail.id,
                                      left: detail.left,
                                      right: detail.right,
                                    })
                                  }
                                  className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                >
                                  <PencilIcon className="size-3" />
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Remove detail slider ${detail.left} to ${detail.right}`}
                                  onClick={() => removeAxis(detail.id)}
                                  className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Trash2Icon className="size-3" />
                                </button>
                              </span>
                            ) : null}
                            <span className="text-right text-[11px] font-medium leading-tight">
                              {detail.right}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="range"
                              min={0}
                              max={100}
                              value={sliderValue}
                              disabled={isTarget}
                              onChange={(event) =>
                                updateDetail(detailIndex, Number(event.target.value))
                              }
                              aria-label={`${detail.left} to ${detail.right}`}
                              className="h-4 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed"
                            />
                            {isWeight ? (
                              <span className="w-7 text-right font-mono text-[9px] text-amber-600 dark:text-amber-300">
                                {influence >= 0 ? "+" : ""}
                                {influence.toFixed(1)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}

                  {editing?.groupId === group.id ? (
                    <div className="space-y-2 border-t border-border/50 bg-muted/10 p-2.5">
                      <Input
                        nativeInput
                        value={editing.left}
                        onChange={(event) => setEditing({ ...editing, left: event.target.value })}
                        placeholder="Left pole for prompt (English)"
                        aria-label="Left pole for prompt in English"
                      />
                      <Input
                        nativeInput
                        value={editing.right}
                        onChange={(event) => setEditing({ ...editing, right: event.target.value })}
                        placeholder="Right pole for prompt (English)"
                        aria-label="Right pole for prompt in English"
                      />
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                        <Button type="button" size="xs" onClick={saveAxis}>
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>
              ))}
          </div>

          {showMatrices ? (
            <div className="mt-3 space-y-2 rounded-lg border border-border/60 bg-muted/10 p-2.5">
              <div className="grid gap-2 lg:grid-cols-2">
                <label className="space-y-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  W · Meta → detail
                  <Textarea
                    value={matrixW}
                    onChange={(event) => setMatrixW(event.target.value)}
                    className="min-h-56 font-mono text-[10px] normal-case"
                    aria-label="Meta to detail weight matrix"
                  />
                </label>
                <label className="space-y-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  A · Detail → detail
                  <Textarea
                    value={matrixA}
                    onChange={(event) => setMatrixA(event.target.value)}
                    className="min-h-56 font-mono text-[10px] normal-case"
                    aria-label="Detail influence weight matrix"
                  />
                </label>
              </div>
              {matrixError ? <p className="text-xs text-destructive">{matrixError}</p> : null}
              <div className="flex justify-end gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setShowMatrices(false)}
                >
                  Cancel
                </Button>
                <Button type="button" size="xs" onClick={applyMatrices}>
                  Apply
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
