import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useState } from "react";
import { GripVertical, Plus, UserRound } from "lucide-react";
import { columns, type Task, type TaskStatus } from "../../shared/tasks";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

const colors: Record<TaskStatus, string> = {
  TRIAGE: "bg-stone-400",
  BACKLOG: "bg-violet-400",
  TODO: "bg-sky-400",
  IN_PROGRESS: "bg-amber-400",
  DONE: "bg-emerald-500",
};

function CardContent({ task }: { task: Task }) {
  return (
    <>
      <h3 className="break-words text-sm font-medium leading-5">{task.title}</h3>
      {task.description && (
        <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
          {task.description}
        </p>
      )}
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <UserRound className="size-3.5 shrink-0" />
        <span className="truncate">{task.assignee || "Unassigned"}</span>
      </div>
    </>
  );
}

function TaskCard({
  task,
  disabled,
  onEdit,
}: {
  task: Task;
  disabled: boolean;
  onEdit: (task: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, disabled });

  return (
    <article
      ref={setNodeRef}
      className={cn(
        "group relative rounded-lg border bg-card shadow-xs transition-shadow hover:shadow-sm",
        isDragging && "opacity-30",
      )}
    >
      <button
        type="button"
        onClick={() => onEdit(task)}
        disabled={disabled}
        className="block w-full rounded-lg p-4 pr-8 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        aria-label={`Edit task: ${task.title}`}
      >
        <CardContent task={task} />
      </button>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Drag task: ${task.title}`}
        disabled={disabled}
        className="absolute right-1 top-3 touch-none rounded p-1 text-muted-foreground opacity-50 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GripVertical className="size-4" />
      </button>
    </article>
  );
}

function Column({
  status,
  label,
  tasks,
  disabled,
  onEdit,
  onCreate,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  disabled: boolean;
  onEdit: (task: Task) => void;
  onCreate: (status: TaskStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled });

  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={cn(
        "min-h-[420px] rounded-xl bg-[#f0f1ed] p-3 transition-colors",
        isOver && "bg-[#e5eadc] ring-2 ring-primary/30",
      )}
    >
      <div className="mb-4 flex items-center gap-2 px-1 pt-1">
        <span className={cn("size-2 rounded-full", colors[status])} />
        <h2 className="text-sm font-semibold">{label}</h2>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label={`Add task to ${label}`}
          disabled={disabled}
          onClick={() => onCreate(status)}
        >
          <Plus />
        </Button>
      </div>
      <div className="space-y-3">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} disabled={disabled} onEdit={onEdit} />
        ))}
        {tasks.length === 0 && (
          <div className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
            No tasks yet
          </div>
        )}
      </div>
    </section>
  );
}

export function Board({
  tasks,
  disabled,
  onEdit,
  onCreate,
  onMove,
}: {
  tasks: Task[];
  disabled: boolean;
  onEdit: (task: Task) => void;
  onCreate: (status: TaskStatus) => void;
  onMove: (task: Task, status: TaskStatus) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeTask = tasks.find((task) => task.id === activeId);

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    const task = tasks.find((item) => item.id === active.id);
    const column = columns.find((item) => item.status === over?.id);

    if (!disabled && task && column && task.status !== column.status) onMove(task, column.status);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={rectIntersection}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="overflow-x-auto pb-4">
        <div className="grid min-w-[1120px] grid-cols-5 gap-4">
          {columns.map((column) => (
            <Column
              key={column.status}
              {...column}
              tasks={tasks.filter((task) => task.status === column.status)}
              disabled={disabled}
              onEdit={onEdit}
              onCreate={onCreate}
            />
          ))}
        </div>
      </div>
      <DragOverlay>
        {activeTask && (
          <div className="rotate-2 rounded-lg border bg-card p-4 shadow-xl">
            <CardContent task={activeTask} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
