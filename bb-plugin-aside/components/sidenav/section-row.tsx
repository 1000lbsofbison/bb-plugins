// The section row.
//
// In the host a section belongs to no project (its schema is only
// { id, name }); it therefore appears in every project where it has threads.
// The count on the right is — as everywhere — the toggle.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { RowCount, RowTail } from "@/components/sidenav/row-slots";
import type { ThreadState } from "@/lib/tree";
import { THREAD_DRAG_TYPE } from "@/components/sidenav/thread-card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export function SectionRow({
  name,
  count,
  state,
  age,
  now,
  collapsed,
  renaming,
  threadCount,
  onToggle,
  onStartRename,
  onCancelRename,
  onRename,
  onDissolve,
  onDropThread,
}: {
  name: string;
  count: number;
  state: ThreadState;
  /** Newest activity inside the section; `null` while it holds no threads. */
  age: number | null;
  now: number;
  collapsed: boolean;
  renaming: boolean;
  threadCount: number;
  onToggle: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (name: string) => void;
  onDissolve: () => void;
  onDropThread: (threadId: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    ref.current?.focus();
    ref.current?.select();
  }, [renaming]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            const threadId = event.dataTransfer.getData(THREAD_DRAG_TYPE);
            if (!threadId) return;
            event.preventDefault();
            event.stopPropagation();
            onDropThread(threadId);
          }}
          onClick={(event) => {
            if (renaming || event.detail > 1) return;
            onToggle();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onStartRename();
          }}
          className="mt-1 flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-0.5 hover:bg-sidebar-accent/60"
        >
          {renaming ? (
            <input
              ref={ref}
              defaultValue={name}
              onClick={(event) => event.stopPropagation()}
              onBlur={onCancelRename}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") onCancelRename();
                if (event.key === "Enter") {
                  const value = event.currentTarget.value.trim();
                  if (value.length === 0) {
                    onCancelRename();
                    return;
                  }
                  onRename(value);
                }
              }}
              className="w-full min-w-0 rounded border border-border bg-background px-1 py-px text-2xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : (
            <span className="min-w-0 truncate text-2xs uppercase tracking-wider text-muted-foreground/70">
              {name}
            </span>
          )}
          <RowCount count={count} open={!collapsed} />
          <RowTail age={age} now={now} state={state} className="ml-auto" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={onStartRename}>
          Rename section
          <ContextMenuShortcut>Double click</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onDissolve}>
          Dissolve section
          <ContextMenuShortcut>{threadCount} threads</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
