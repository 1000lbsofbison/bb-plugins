// The tree the sidenav draws — as pure functions, without React and without
// SDK hooks. Everything here is testable without a running BB.
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

/** A root thread with all of its visible descendants, flat. */
export interface Family {
  root: PluginSidebarThread;
  children: PluginSidebarThread[];
}

/** A section heading inside a project, or the area before it. */
export interface SectionBlock {
  /** Null for the families without a section; those always come first. */
  section: { id: string; name: string } | null;
  families: Family[];
}

export interface ProjectBlock {
  project: PluginSidebarProject;
  /** All families of the project, regardless of section and condensing. */
  families: Family[];
  blocks: SectionBlock[];
}

export type ThreadState =
  | "failed"
  | "needs-you"
  | "working"
  | "unread"
  | "quiet";

export const THREAD_STATE_RANK: Readonly<Record<ThreadState, number>> = {
  failed: 0,
  "needs-you": 1,
  working: 2,
  unread: 3,
  quiet: 4,
};

export function threadTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled";
}

/** Every live signal BB knows for a sidebar row. */
export function isWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft"
  );
}

export function needsUser(thread: PluginSidebarThread): boolean {
  return (
    thread.hasPendingInteraction || thread.indicator === "waiting-for-input"
  );
}

export function hasFailed(thread: PluginSidebarThread): boolean {
  return thread.indicator === "unread-error";
}

export function isUnread(thread: PluginSidebarThread): boolean {
  return thread.isUnread || thread.indicator === "unread-success";
}

/**
 * A row's state. The order of the checks is the ranking: a failed turn stays
 * failed, even when the thread next to it is already working again.
 */
export function threadState(thread: PluginSidebarThread): ThreadState {
  if (hasFailed(thread)) return "failed";
  if (needsUser(thread)) return "needs-you";
  if (isWorking(thread)) return "working";
  if (isUnread(thread)) return "unread";
  return "quiet";
}

/** A whole family's state: the most urgent one among its members. */
export function familyState(family: Family): ThreadState {
  return familyMembers(family)
    .map(threadState)
    .reduce<ThreadState>(
      (worst, state) =>
        THREAD_STATE_RANK[state] < THREAD_STATE_RANK[worst] ? state : worst,
      "quiet",
    );
}

/**
 * A project's state: the most urgent one among its families. This is the mark
 * next to the project name — especially while the project is collapsed.
 * Otherwise you would have to expand it to learn whether expanding is worth it.
 */
export function projectState(families: readonly Family[]): ThreadState {
  return families
    .map(familyState)
    .reduce<ThreadState>(
      (worst, state) =>
        THREAD_STATE_RANK[state] < THREAD_STATE_RANK[worst] ? state : worst,
      "quiet",
    );
}

export function familyMembers(family: Family): PluginSidebarThread[] {
  return [family.root, ...family.children];
}

export function familyWaits(family: Family): boolean {
  return familyMembers(family).some(needsUser);
}

/**
 * A thread's visible ancestor. If the real parent is not in the list — archived,
 * deleted, from another project — the thread becomes a root itself. Otherwise it
 * would no longer be reachable through the sidenav.
 */
function visibleRootOf(
  thread: PluginSidebarThread,
  byId: ReadonlyMap<string, PluginSidebarThread>,
): PluginSidebarThread {
  let current = thread;
  const seen = new Set([thread.id]);
  while (current.parentThreadId !== null) {
    const parent = byId.get(current.parentThreadId);
    if (
      parent === undefined ||
      parent.projectId !== thread.projectId ||
      seen.has(parent.id)
    ) {
      break;
    }
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

export interface GroupOptions {
  /** Show archived threads too. */
  archived: boolean;
  /** The host's sections, in their order. */
  sections: readonly { id: string; name: string }[];
  /** What the families inside a block are sorted by. */
  threadSort: "newest" | "state";
}

/**
 * Threads → projects → sections → families.
 *
 * Projects come in the host's order; since bb 0.43 the dragged order lives
 * there, and it applies across devices.
 */
export function groupThreads(
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  options: GroupOptions,
): ProjectBlock[] {
  const visible = threads.filter(
    (thread) => options.archived || !thread.isArchived,
  );
  const byProject = new Map<string, PluginSidebarThread[]>();
  for (const thread of visible) {
    const bucket = byProject.get(thread.projectId) ?? [];
    bucket.push(thread);
    byProject.set(thread.projectId, bucket);
  }

  return projects.map((project) => {
    const own = byProject.get(project.id) ?? [];
    const byId = new Map(own.map((thread) => [thread.id, thread]));
    const familyByRoot = new Map<string, Family>();

    for (const thread of own) {
      const root = visibleRootOf(thread, byId);
      const family = familyByRoot.get(root.id) ?? { root, children: [] };
      if (thread.id !== root.id) family.children.push(thread);
      familyByRoot.set(root.id, family);
    }

    const families = [...familyByRoot.values()];
    for (const family of families) {
      family.children.sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
    }

    const sorted = sortFamilies(families, options.threadSort);
    return {
      project,
      families: sorted,
      blocks: splitIntoSections(sorted, options.sections),
    };
  });
}

/**
 * Pinned threads sit on top in every mode — that is what pinning means, and
 * `threads.reorderPinned` is also the only thread order the host keeps at all.
 */
export function sortFamilies(
  families: readonly Family[],
  mode: "newest" | "state",
): Family[] {
  const pinned = families.filter((family) => family.root.isPinned);
  const rest = families.filter((family) => !family.root.isPinned);
  const byNewest = (left: Family, right: Family) =>
    right.root.createdAt - left.root.createdAt ||
    left.root.id.localeCompare(right.root.id);
  const sortedRest =
    mode === "state"
      ? [...rest].sort(
          (left, right) =>
            THREAD_STATE_RANK[familyState(left)] -
              THREAD_STATE_RANK[familyState(right)] || byNewest(left, right),
        )
      : [...rest].sort(byNewest);
  return [...pinned].sort(byNewest).concat(sortedRest);
}

/**
 * In the host a section belongs to no project: its schema is only
 * `{ id, name }`, and threads point at it through `sectionId`. It therefore
 * appears in every project where it has threads — and nowhere else.
 *
 * Sections sit at the **top**, in the order the caller supplies (newest first):
 * a section just created must be visible without scrolling past the loose
 * threads. The threads without a section follow below — with no invented
 * "Other" heading.
 */
export function splitIntoSections(
  families: readonly Family[],
  sections: readonly { id: string; name: string }[],
): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  for (const section of sections) {
    const own = families.filter(
      (family) => family.root.sectionId === section.id,
    );
    if (own.length) blocks.push({ section, families: own });
  }
  const loose = families.filter((family) => family.root.sectionId === null);
  if (loose.length) blocks.push({ section: null, families: loose });
  return blocks;
}

/**
 * The personal project has a synthetic id (`proj_personal`) the host does not
 * sort — `projects.reorder` answers 404 for it. We therefore keep its position
 * ourselves: as an anchor behind a real project, `null` meaning the very top.
 */
export function placePersonal(
  blocks: readonly ProjectBlock[],
  personalProjectId: string,
  afterProjectId: string | null,
): ProjectBlock[] {
  const personal = blocks.find((block) => block.project.id === personalProjectId);
  if (personal === undefined) return [...blocks];
  const rest = blocks.filter((block) => block.project.id !== personalProjectId);
  if (afterProjectId === null) return [personal, ...rest];
  const anchor = rest.findIndex((block) => block.project.id === afterProjectId);
  // An anchor that no longer exists (project deleted) leaves the personal
  // project at the bottom instead of making it disappear.
  if (anchor < 0) return [...rest, personal];
  return [...rest.slice(0, anchor + 1), personal, ...rest.slice(anchor + 1)];
}

/**
 * Condensing instead of filtering: what is quiet becomes a single row, but does
 * not disappear. Pinned threads always stay visible — you pulled them up
 * yourself.
 */
export function splitQuiet(families: readonly Family[]): {
  loud: Family[];
  quiet: Family[];
} {
  const loud: Family[] = [];
  const quiet: Family[] = [];
  for (const family of families) {
    const isQuiet = familyState(family) === "quiet" && !family.root.isPinned;
    (isQuiet ? quiet : loud).push(family);
  }
  return { loud, quiet };
}

/** Project order for the modes the user can choose. */
export function sortProjects(
  blocks: readonly ProjectBlock[],
  mode: "manual" | "activity" | "name",
): ProjectBlock[] {
  if (mode === "name") {
    return [...blocks].sort((left, right) =>
      left.project.name.localeCompare(right.project.name),
    );
  }
  if (mode === "activity") {
    const score = (block: ProjectBlock) =>
      block.families.reduce((sum, family) => {
        const state = familyState(family);
        if (state === "needs-you") return sum + 100;
        if (state === "failed") return sum + 50;
        if (state === "working") return sum + 10;
        if (state === "unread") return sum + 1;
        return sum;
      }, 0);
    return [...blocks].sort((left, right) => score(right) - score(left));
  }
  return [...blocks];
}

/**
 * Projects without a thread disappear.
 *
 * An empty project is a row that answers nothing — whoever created twenty
 * repositories would otherwise scroll past nineteen headings. Two exceptions:
 * the switch in the View menu brings them back, and the project you are
 * currently in always stays — otherwise the place vanishes from under your feet
 * the moment you archive its last thread.
 */
export function withoutEmptyProjects(
  blocks: readonly ProjectBlock[],
  keepProjectId: string | null,
): ProjectBlock[] {
  return blocks.filter(
    (block) => block.families.length > 0 || block.project.id === keepProjectId,
  );
}

/**
 * The number in the header: how many root threads the list holds.
 *
 * Deliberately independent of what is collapsed right now. Collapsing is a
 * question of presentation; a number that drops to 0 along with it claims there
 * is nothing left.
 */
export function countFamilies(blocks: readonly ProjectBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.families.length, 0);
}

/**
 * The newest activity across a set of families, children included.
 *
 * `null` means there is nothing to date — an empty project. Children count on
 * purpose: the mark beside this number summarises the whole family too, so a
 * project reading "3d" while an agent works inside it would contradict its own
 * mark.
 */
export function latestActivity(families: readonly Family[]): number | null {
  let latest: number | null = null;
  for (const family of families) {
    for (const member of familyMembers(family)) {
      if (latest === null || member.updatedAt > latest) latest = member.updatedAt;
    }
  }
  return latest;
}

/** Every open question, longest wait first. */
export function waitingThreads(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  return threads
    .filter((thread) => !thread.isArchived && needsUser(thread))
    .sort(
      (left, right) =>
        left.latestAttentionAt - right.latestAttentionAt ||
        left.id.localeCompare(right.id),
    );
}
