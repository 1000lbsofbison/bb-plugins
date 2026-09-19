// The JSON output of an export, rendered next to the button that produced it.
import { Button } from "@/components/ui/button";

export type ExportedFile = { filename: string; json: string };

/**
 * Feedback has to appear where the eye already is. Rendered at the bottom of
 * the panel this block lands below the run list — off screen in a narrow
 * panel — and a successful export looks like a button that did nothing.
 */
export function ExportedFileView({
  exported,
  onDismiss,
}: {
  exported: ExportedFile | null;
  onDismiss: () => void;
}) {
  if (!exported) return null;
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">
        {exported.filename} — copy it and put it in the repo.
      </p>
      <textarea
        readOnly
        value={exported.json}
        rows={10}
        aria-label="Exported JSON"
        className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[11px]"
      />
      <Button size="sm" variant="outline" onClick={onDismiss}>
        Close
      </Button>
    </div>
  );
}
