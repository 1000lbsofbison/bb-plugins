// Directory of the project's crews (§3.9.3): what a lead needs to know about
// the other crews — name, summary, task, status, branch, lead, open
// dependencies. Leads always see it; under `crossCrew: open` every member does.
import type { CrewModels } from "./policy";
import type { CrewRow, MemberRow, Store } from "./store";

export type DirectoryEntry = {
  crew: string;
  summary: string;
  task: string | null;
  status: string;
  branch: string | null;
  lead: string | null;
  waitsFor: { task: string; until: string }[];
  mergeRequest: string | null;
};

/** Why the member may not read the directory, or null. */
export function directoryRefusal(member: Pick<MemberRow, "lead">, crossCrew: "leads" | "open" | "none"): string | null {
  if (member.lead || crossCrew === "open") return null;
  return "crew_directory is for leads (all members only under crossCrew: open). Ask your lead.";
}

export function buildDirectory(store: Store, models: CrewModels, projectId: string): DirectoryEntry[] {
  return store.listCrews(projectId).map((crew: CrewRow) => {
    const spec = models(crew).spec;
    const lead = store.listMembers(crew.id).find((member) => member.lead) ?? null;
    const env = lead ? store.memberEnv(lead.id) : null;
    const open = store.listMerges({ crewId: crew.id, states: ["open", "returned"] })[0] ?? null;
    return {
      crew: crew.name,
      summary: spec?.summary ?? "",
      task: spec?.task ?? null,
      status: crew.status,
      branch: env?.branch ?? null,
      lead: lead?.address ?? null,
      waitsFor: store
        .listDependencies(crew.id)
        .filter((row) => row.state === "open")
        .map((row) => ({ task: row.taskKey, until: row.until })),
      mergeRequest: open ? `${open.id} ${open.state}` : null,
    };
  });
}

export function formatDirectory(entries: readonly DirectoryEntry[], self: string | null = null): string[] {
  if (entries.length === 0) return ["No crews in this project."];
  return entries.map(
    (entry) =>
      `- ${entry.crew}${entry.crew === self ? " (yours)" : ""} · ${entry.status} · task ${entry.task ?? "-"} · branch ${entry.branch ?? "-"} · lead ${entry.lead ?? "-"}${
        entry.waitsFor.length ? ` · waits for ${entry.waitsFor.map((w) => `${w.task} until ${w.until}`).join(", ")}` : ""
      }${entry.mergeRequest ? ` · MR ${entry.mergeRequest}` : ""}${entry.summary ? `\n  ${entry.summary}` : ""}`,
  );
}
