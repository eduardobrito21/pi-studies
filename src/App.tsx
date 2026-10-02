import { useEffect, useState } from "react";
import { ArrowUpRight, LayoutGrid, Plus } from "lucide-react";
import { type Task, type TaskStatus } from "../shared/tasks";
import { api } from "./lib/api";
import { Button } from "./components/ui/button";
import { Board } from "./components/Board";
import { TaskDialog } from "./components/TaskDialog";

type Editor = { task: Task | null; status: TaskStatus };

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);

  async function load() {
    setLoading(true);
    setError("");

    try {
      setTasks(await api.list());
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      setError(error instanceof Error ? error.message : "Could not load tasks");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function move(task: Task, status: TaskStatus) {
    setSaving(true);
    setError("");

    try {
      const updated = await api.update(task.id, { status });
      setTasks((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not move task");
    } finally {
      setSaving(false);
    }
  }

  const done = tasks.filter((task) => task.status === "DONE").length;
  const disabled = loading || saving || loadFailed || editor !== null;

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white/70 px-6 py-4 sm:px-10">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-white">
            <LayoutGrid className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">Taskboard</span>
          <span className="ml-auto rounded-full border px-3 py-1 text-[11px] text-muted-foreground">
            LOCAL WORKSPACE
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[1680px] px-6 py-10 sm:px-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              One board. Less noise.
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">Your tasks, in motion.</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              From the first idea to the final checkmark.
            </p>
          </div>
          <Button onClick={() => setEditor({ task: null, status: "TRIAGE" })} disabled={disabled}>
            <Plus /> New task
          </Button>
        </div>
        <div className="mb-5 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Board</span>
          <span>·</span>
          <span>
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </span>
          <span>·</span>
          <span>{done} done</span>
          <span className="ml-auto" role="status">
            {loading ? "Loading…" : saving ? "Saving…" : "Drag a handle to change status"}
          </span>
        </div>
        {error && (
          <div
            role="alert"
            className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
          >
            <span className="flex-1">{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading || saving}
            >
              Retry
            </Button>
          </div>
        )}
        <Board
          tasks={tasks}
          disabled={disabled}
          onCreate={(status) => setEditor({ task: null, status })}
          onEdit={(task) => setEditor({ task, status: task.status })}
          onMove={(task, status) => void move(task, status)}
        />
        <footer className="mt-4 flex items-center gap-1 text-xs text-muted-foreground">
          <ArrowUpRight className="size-3.5" /> Click a task to edit it. Status can also be changed
          in the editor.
        </footer>
      </main>
      {editor && (
        <TaskDialog
          task={editor.task}
          initialStatus={editor.status}
          onClose={() => setEditor(null)}
          onSave={async (data) => {
            const saved = editor.task
              ? await api.update(editor.task.id, data)
              : await api.create(data);

            setTasks((items) =>
              editor.task
                ? items.map((item) => (item.id === saved.id ? saved : item))
                : [...items, saved],
            );
          }}
          onDelete={async () => {
            if (!editor.task) return;
            await api.delete(editor.task.id);
            setTasks((items) => items.filter((item) => item.id !== editor.task!.id));
          }}
        />
      )}
    </div>
  );
}
