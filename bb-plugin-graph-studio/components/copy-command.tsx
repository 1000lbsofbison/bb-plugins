// A CLI line you can take with you.
//
// Every place that shows a `bb graph-studio …` command shows it through this,
// so the command on screen and the command on the clipboard are the same
// string by construction. Rendering the text twice — once for the eye, once
// for `writeText` — is exactly how the two drift apart.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

const LABEL: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Did not work",
};

export function CopyCommand({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");

  // "Kopiert" is feedback, not a mode: it has to go away on its own, and it
  // has to go away when the command underneath it changes, or the label
  // claims the clipboard holds something it does not.
  useEffect(() => setState("idle"), [command]);
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = () => {
    // `navigator.clipboard` is typed as always present but is absent in an
    // insecure context and in older webviews. Saying so is the point: the
    // command stays selectable, so the fallback is to select it by hand
    // rather than to wonder why nothing happened.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setState("failed");
      return;
    }
    void clipboard.writeText(command).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md bg-muted px-2 py-1 font-mono text-[11px]">
        {command}
      </code>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-1.5 text-[11px]"
        onClick={copy}
        aria-label={`Copy command: ${command}`}
      >
        <Icon name={state === "copied" ? "Check" : "Copy"} className="size-3.5" />
        {LABEL[state]}
      </Button>
    </div>
  );
}
