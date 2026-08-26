import type {
  WorkjetWorkerGraph,
  WorkjetWorkerProfile,
  WorkjetWorkerProfileId,
} from "@t3tools/contracts";
import {
  GitBranchPlusIcon,
  LayoutGridIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UnlinkIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const NODE_WIDTH = 192;
const NODE_HEIGHT = 76;
const CANVAS_HEIGHT = 520;

type Position = {
  readonly workerId: WorkjetWorkerProfileId;
  readonly x: number;
  readonly y: number;
};

function defaultPositions(workers: ReadonlyArray<WorkjetWorkerProfile>): Position[] {
  return workers.map((worker, index) => ({
    workerId: worker.id,
    x: 30 + (index % 3) * 230,
    y: 40 + Math.floor(index / 3) * 108,
  }));
}

export function sanitizeWorkjetWorkerGraph(
  graph: WorkjetWorkerGraph,
  workers: ReadonlyArray<WorkjetWorkerProfile>,
): WorkjetWorkerGraph {
  const ids = new Set(workers.map((worker) => worker.id));
  const defaults = defaultPositions(workers);
  const positions = workers.map(
    (worker) =>
      graph.positions.find((position) => position.workerId === worker.id) ??
      defaults.find((position) => position.workerId === worker.id)!,
  );
  const seen = new Set<string>();
  const dependencies = graph.dependencies.filter((dependency) => {
    const key = `${dependency.fromWorkerId}->${dependency.toWorkerId}`;
    if (
      !ids.has(dependency.fromWorkerId) ||
      !ids.has(dependency.toWorkerId) ||
      dependency.fromWorkerId === dependency.toWorkerId ||
      seen.has(key)
    ) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return { positions, dependencies };
}

export function autoLayoutWorkjetWorkerGraph(
  graph: WorkjetWorkerGraph,
  workers: ReadonlyArray<WorkjetWorkerProfile>,
): WorkjetWorkerGraph {
  const clean = sanitizeWorkjetWorkerGraph(graph, workers);
  const incoming = new Set(clean.dependencies.map((dependency) => dependency.toWorkerId));
  const roots = workers.filter((worker) => !incoming.has(worker.id)).map((worker) => worker.id);
  const levels: WorkjetWorkerProfileId[][] = [roots];
  const seen = new Set(roots);
  while ((levels.at(-1)?.length ?? 0) > 0) {
    const previous = levels.at(-1) ?? [];
    const next = [
      ...new Set(
        clean.dependencies
          .filter(
            (dependency) =>
              previous.includes(dependency.fromWorkerId) && !seen.has(dependency.toWorkerId),
          )
          .map((dependency) => dependency.toWorkerId),
      ),
    ];
    if (next.length === 0) break;
    next.forEach((id) => seen.add(id));
    levels.push(next);
  }
  const unplaced = workers.filter((worker) => !seen.has(worker.id)).map((worker) => worker.id);
  if (unplaced.length > 0) levels.push(unplaced);
  return {
    ...clean,
    positions: levels.flatMap((ids, level) =>
      ids.map((workerId, index) => ({ workerId, x: 58 + level * 250, y: 48 + index * 108 })),
    ),
  };
}

export function WorkjetWorkerOrganigram({
  workers,
  graph,
  onChange,
  onAddWorker,
  onEditWorker,
  onDeleteWorker,
}: {
  readonly workers: ReadonlyArray<WorkjetWorkerProfile>;
  readonly graph: WorkjetWorkerGraph;
  readonly onChange: (graph: WorkjetWorkerGraph) => void;
  readonly onAddWorker: (parentId: WorkjetWorkerProfileId | null) => void;
  readonly onEditWorker: (workerId: WorkjetWorkerProfileId) => void;
  readonly onDeleteWorker: (workerId: WorkjetWorkerProfileId) => void;
}) {
  const cleanGraph = useMemo(() => sanitizeWorkjetWorkerGraph(graph, workers), [graph, workers]);
  const [positions, setPositions] = useState(cleanGraph.positions);
  const [selectedWorkerId, setSelectedWorkerId] = useState<WorkjetWorkerProfileId | null>(null);
  const [selectedEdgeIndex, setSelectedEdgeIndex] = useState<number | null>(null);
  const [connectionSource, setConnectionSource] = useState<WorkjetWorkerProfileId | null>(null);
  const positionsRef = useRef(cleanGraph.positions);
  const drag = useRef<{
    readonly workerId: WorkjetWorkerProfileId;
    readonly dx: number;
    readonly dy: number;
  } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPositions(cleanGraph.positions);
    positionsRef.current = cleanGraph.positions;
  }, [cleanGraph.positions]);

  const positionFor = (workerId: WorkjetWorkerProfileId) =>
    positions.find((position) => position.workerId === workerId) ?? {
      workerId,
      x: 58,
      y: 48,
    };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, workerId: WorkjetWorkerProfileId) => {
    if ((event.target as HTMLElement).closest("button") !== null) return;
    const bounds = canvas.current?.getBoundingClientRect();
    if (bounds === undefined) return;
    const position = positionFor(workerId);
    setSelectedWorkerId(workerId);
    setSelectedEdgeIndex(null);
    drag.current = {
      workerId,
      dx: event.clientX - bounds.left + (canvas.current?.scrollLeft ?? 0) - position.x,
      dy: event.clientY - bounds.top + (canvas.current?.scrollTop ?? 0) - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const bounds = canvas.current?.getBoundingClientRect();
    if (current === null || bounds === undefined) return;
    const nextPosition = {
      workerId: current.workerId,
      x: Math.max(
        8,
        Math.min(
          Math.max(bounds.width, canvas.current?.scrollWidth ?? bounds.width) - NODE_WIDTH - 8,
          event.clientX - bounds.left + (canvas.current?.scrollLeft ?? 0) - current.dx,
        ),
      ),
      y: Math.max(
        8,
        Math.min(
          Math.max(CANVAS_HEIGHT, canvas.current?.scrollHeight ?? CANVAS_HEIGHT) - NODE_HEIGHT - 8,
          event.clientY - bounds.top + (canvas.current?.scrollTop ?? 0) - current.dy,
        ),
      ),
    };
    setPositions((currentPositions) => {
      const nextPositions = currentPositions.map((position) =>
        position.workerId === current.workerId ? nextPosition : position,
      );
      positionsRef.current = nextPositions;
      return nextPositions;
    });
  };

  const endDrag = () => {
    if (drag.current === null) return;
    drag.current = null;
    onChange({ ...cleanGraph, positions: positionsRef.current });
  };

  const connectTo = (targetId: WorkjetWorkerProfileId) => {
    if (connectionSource === null || connectionSource === targetId) return;
    const exists = cleanGraph.dependencies.some(
      (dependency) =>
        dependency.fromWorkerId === connectionSource && dependency.toWorkerId === targetId,
    );
    const dependencies = exists
      ? cleanGraph.dependencies
      : [...cleanGraph.dependencies, { fromWorkerId: connectionSource, toWorkerId: targetId }];
    setConnectionSource(null);
    setSelectedWorkerId(null);
    setSelectedEdgeIndex(exists ? null : dependencies.length - 1);
    onChange({ ...cleanGraph, positions, dependencies });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-muted/10">
      <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <Button type="button" size="sm" variant="outline" onClick={() => onAddWorker(null)}>
          <PlusIcon className="size-3.5" />
          Worker
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            const next = autoLayoutWorkjetWorkerGraph(cleanGraph, workers);
            setPositions(next.positions);
            onChange(next);
          }}
        >
          <LayoutGridIcon className="size-3.5" />
          Arrange
        </Button>
        {selectedWorkerId === null ? null : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onEditWorker(selectedWorkerId)}
            >
              <PencilIcon className="size-3.5" />
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onAddWorker(selectedWorkerId)}
            >
              <GitBranchPlusIcon className="size-3.5" />
              Child
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                onDeleteWorker(selectedWorkerId);
                setSelectedWorkerId(null);
              }}
            >
              <Trash2Icon className="size-3.5" />
              Delete
            </Button>
          </>
        )}
        {selectedEdgeIndex === null ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange({
                ...cleanGraph,
                positions,
                dependencies: cleanGraph.dependencies.filter(
                  (_, index) => index !== selectedEdgeIndex,
                ),
              });
              setSelectedEdgeIndex(null);
            }}
          >
            <UnlinkIcon className="size-3.5" />
            Remove connection
          </Button>
        )}
        {connectionSource === null ? null : (
          <span className="ml-auto text-[11px] text-amber-600 dark:text-amber-300">
            Choose target · Esc cancels
          </span>
        )}
      </div>

      <div
        ref={canvas}
        className="relative h-[520px] touch-none overflow-auto bg-background/60 [background-image:radial-gradient(circle,color-mix(in_oklab,var(--border)_70%,transparent)_1px,transparent_1px)] [background-size:22px_22px]"
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          setSelectedWorkerId(null);
          setSelectedEdgeIndex(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setConnectionSource(null);
          if ((event.key === "Delete" || event.key === "Backspace") && selectedEdgeIndex !== null) {
            onChange({
              ...cleanGraph,
              positions,
              dependencies: cleanGraph.dependencies.filter(
                (_, index) => index !== selectedEdgeIndex,
              ),
            });
            setSelectedEdgeIndex(null);
          }
        }}
        tabIndex={0}
        aria-label="Worker dependency organigram"
      >
        <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
          {cleanGraph.dependencies.map((dependency, index) => {
            const from = positionFor(dependency.fromWorkerId);
            const to = positionFor(dependency.toWorkerId);
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            const middle = x1 + (x2 - x1) / 2;
            return (
              <path
                key={`${dependency.fromWorkerId}-${dependency.toWorkerId}`}
                d={`M ${String(x1)} ${String(y1)} C ${String(middle)} ${String(y1)}, ${String(middle)} ${String(y2)}, ${String(x2)} ${String(y2)}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={selectedEdgeIndex === index ? 2.2 : 1.4}
                className={cn(
                  "pointer-events-stroke cursor-pointer text-muted-foreground/50",
                  selectedEdgeIndex === index && "text-primary",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedEdgeIndex(index);
                  setSelectedWorkerId(null);
                }}
              />
            );
          })}
        </svg>

        {workers.map((worker) => {
          const position = positionFor(worker.id);
          return (
            <article
              key={worker.id}
              className={cn(
                "absolute z-[1] h-[76px] w-48 cursor-grab select-none rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm active:cursor-grabbing",
                selectedWorkerId === worker.id && "border-primary ring-2 ring-primary/10",
                connectionSource === worker.id && "border-amber-500/70",
              )}
              style={{ left: position.x, top: position.y }}
              onPointerDown={(event) => beginDrag(event, worker.id)}
              onDoubleClick={() => onEditWorker(worker.id)}
            >
              <button
                type="button"
                aria-label={`Connect dependency to ${worker.name}`}
                className="absolute left-[-5px] top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-card bg-muted-foreground hover:bg-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  connectTo(worker.id);
                }}
              />
              <p className="truncate text-xs font-medium">{worker.name}</p>
              <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                {worker.instructions ?? "No task set."}
              </p>
              <button
                type="button"
                aria-label={`Start dependency from ${worker.name}`}
                className="absolute right-[-5px] top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-card bg-muted-foreground hover:bg-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  setConnectionSource(worker.id);
                  setSelectedWorkerId(worker.id);
                  setSelectedEdgeIndex(null);
                }}
              />
              <button
                type="button"
                aria-label={`Add child worker to ${worker.name}`}
                className="absolute bottom-[-11px] right-2 grid size-[22px] place-items-center rounded-full border border-border bg-card text-muted-foreground hover:border-primary/60 hover:bg-primary hover:text-primary-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddWorker(worker.id);
                }}
              >
                <PlusIcon className="size-3.5" />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
