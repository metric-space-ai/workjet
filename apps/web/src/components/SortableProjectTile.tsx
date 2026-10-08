import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";

export function SortableProjectTile({
  id,
  label,
  disabled,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly children: (handle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const handle = disabled ? null : (
    <Button
      ref={setActivatorNodeRef}
      type="button"
      size="icon-xs"
      variant="ghost"
      className="touch-none cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
      aria-label={`Move ${label}`}
    >
      <GripVerticalIcon className="size-4" aria-hidden="true" />
    </Button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("min-w-0", isDragging && "relative z-10 opacity-80")}
      data-workjet-project-tile=""
    >
      {children(handle)}
    </div>
  );
}
