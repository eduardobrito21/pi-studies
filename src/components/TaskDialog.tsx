import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import {
  columns,
  taskStatusSchema,
  type CreateTaskInput,
  type Task,
  type TaskStatus,
} from "../../shared/tasks";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function TaskDialog({
  task,
  initialStatus,
  onClose,
  onSave,
  onDelete,
}: {
  task: Task | null;
  initialStatus: TaskStatus;
  onClose: () => void;
  onSave: (data: CreateTaskInput) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [assignee, setAssignee] = useState(task?.assignee ?? "");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await onSave({ title, description, assignee, status });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save task");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");

    try {
      await onDelete();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete task");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Keep it simple. Give the task a title and a place on the board.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <fieldset disabled={busy} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                autoFocus
                required
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs to be done?"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-description">
                Description <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="task-description"
                maxLength={10000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="A little more context…"
                className="min-h-28"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="task-assignee">Assignee</Label>
                <Input
                  id="task-assignee"
                  maxLength={100}
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                  placeholder="Unassigned"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="task-status">Status</Label>
                <Select
                  value={status}
                  onValueChange={(value) => setStatus(taskStatusSchema.parse(value))}
                  disabled={busy}
                >
                  <SelectTrigger id="task-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((column) => (
                      <SelectItem key={column.status} value={column.status}>
                        {column.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {confirmDelete ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="mb-3 text-sm">Delete this task? This cannot be undone.</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Delete task
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep task
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 border-t pt-4">
              <div>
                {task && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive"
                    aria-label="Delete task"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !title.trim()}>
                  {busy ? "Saving…" : task ? "Save changes" : "Create task"}
                </Button>
              </div>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
