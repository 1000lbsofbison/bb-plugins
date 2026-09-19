// The tag editor inside a project's context menu.
//
// Three things in one block, because they are one thought: what this project
// carries, what it could carry, and a field for something that does not exist
// yet. Splitting them across a submenu would make "add a tag I already use"
// two navigations deep.
//
// The chips are grey. Colour in this sidenav says exactly two things — amber
// "waiting for you", red "failed" — and a tag is neither. A palette of tag
// colours would spend the one signal the list has left on labels that already
// carry their own name.
//
// Not menu items: like the colour swatches next to them, these are plain
// buttons, so the surrounding menu does not close on every click. Tagging a
// project usually means setting two or three at once.
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { MAX_TAGS_PER_PROJECT, MAX_TAG_LENGTH, normalizeTag } from "@/lib/tags";

function Chip({
  label,
  active,
  onClick,
  title,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex max-w-full items-center gap-1 rounded-full border px-1.5 py-px text-2xs",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "border-border bg-sidebar-accent text-foreground"
          : "border-border-hairline text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      {children}
    </button>
  );
}

export function TagEditor({
  tags,
  knownTags,
  onChange,
}: {
  /** What this project carries. */
  tags: readonly string[];
  /** Every tag in use anywhere — the pool to pick from. */
  knownTags: readonly string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const full = tags.length >= MAX_TAGS_PER_PROJECT;
  const unused = knownTags.filter((tag) => !tags.includes(tag));

  function add(value: string) {
    const tag = normalizeTag(value);
    if (tag === null || tags.includes(tag) || full) return;
    onChange([...tags, tag]);
  }

  return (
    <div className="px-2 pb-1.5 pt-1">
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 pb-1.5">
          {tags.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              active
              title={`Remove ${tag} from this project`}
              onClick={() => onChange(tags.filter((entry) => entry !== tag))}
            >
              <Icon name="X" className="size-2.5 shrink-0 opacity-60" aria-hidden />
            </Chip>
          ))}
        </div>
      ) : null}

      <input
        ref={inputRef}
        value={draft}
        placeholder={full ? `${MAX_TAGS_PER_PROJECT} is the limit` : "Add a tag …"}
        disabled={full}
        maxLength={MAX_TAG_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        // The menu around this field reads keystrokes as typeahead and would
        // jump to an entry on every letter, so the input keeps its keys.
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            setDraft("");
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          add(draft);
          setDraft("");
        }}
        className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-2xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
      />

      {unused.length > 0 && !full ? (
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto pt-1.5">
          {unused.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              active={false}
              title={`Add ${tag} to this project`}
              onClick={() => add(tag)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
