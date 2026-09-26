// A real full screen: a layer over the whole BB window, not a column that
// merely hides its neighbours.
//
// The old focus mode only dropped the prose around the canvas, which left the
// graph as narrow as the panel it lived in — a reset more than a mode. Portaled
// to the body, the graph gets the window and the editing moves into a sidebar
// beside it instead of queueing up underneath.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "../lib/portal-scope";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function FullscreenLayer({
  title,
  status,
  actions,
  sidebar,
  children,
  onClose,
}: {
  title: string;
  /** A short line next to the title — the run status, the problem count. */
  status?: ReactNode;
  /** Buttons before "Leave full screen", e.g. Save. */
  actions?: ReactNode;
  /** The column on the right; left out, the canvas takes the full width. */
  sidebar?: ReactNode;
  /** The canvas. It is given the full height of the layer. */
  children: ReactNode;
  onClose: () => void;
}) {
  // Portaled content carries the plugin's scope attributes, or the plugin's
  // stylesheet — scoped to its root — would not reach it.
  const scope = usePortalScopeProps();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      {...scope}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} — full screen`}
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-xs">
        <span className="truncate text-sm font-medium">{title}</span>
        {status ? (
          <span className="min-w-0 truncate text-muted-foreground">{status}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose}>
            <Icon name="X" className="size-4" />
            Leave full screen
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-w-0 flex-1 p-2")}>{children}</div>
        {sidebar ? (
          <aside className="w-[24rem] max-w-[42vw] shrink-0 overflow-y-auto border-l border-border/60 bg-background px-4 py-3">
            {sidebar}
          </aside>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
