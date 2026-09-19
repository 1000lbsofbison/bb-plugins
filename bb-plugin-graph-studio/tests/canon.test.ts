// The library against the agentic-pattern catalogue.
//
// The catalogue lists the patterns; this file lists which template is each one,
// and fails when a name on the left has nothing on the right. Written down
// because the gap was invisible until somebody read both documents side by
// side: six of the nine canonical patterns were there, three were not, and
// nothing said so.
//
// One entry is deliberately empty, and that is a claim as much as the others:
// blackboard needs a shared writable space, and state here is per node. It
// stays listed so the absence is a decision on record rather than an oversight.
// Swarm was the second such entry until #17 gave an edge a target it reads
// from a field.
import { describe, expect, it } from "vitest";
import {
  TEMPLATES,
  templateById,
  templateGroup,
  templatePattern,
  searchGraphs,
} from "../lib/templates";

/** Catalogue section 2 — the canon, and section 1 — the topologies. */
const CANON: Array<{ pattern: string; templates: string[] }> = [
  { pattern: "Prompt chaining", templates: ["prompt-chaining"] },
  { pattern: "Routing", templates: ["routing", "simple-merge", "multi-choice"] },
  { pattern: "Parallelization — sectioning", templates: ["parallel-sectioning"] },
  { pattern: "Parallelization — voting", templates: ["ensemble-vote"] },
  {
    pattern: "Orchestrator–worker",
    templates: ["map-reduce", "plan-and-execute"],
  },
  { pattern: "Evaluator–optimizer", templates: ["evaluator-optimizer", "harness-arc"] },
  { pattern: "ReAct", templates: ["react-loop"] },
  { pattern: "Supervisor", templates: ["supervisor"] },
  { pattern: "Hierarchical / subgraph", templates: ["hierarchical"] },
  { pattern: "State machine", templates: ["state-machine", "deferred-choice", "milestone"] },
  { pattern: "Guardrail", templates: ["guardrail"] },
  { pattern: "Circuit breaker", templates: ["circuit-breaker"] },
  { pattern: "Saga / compensation", templates: ["saga-compensation"] },
  // Listed as "not expressible" until #16: a node that gave up ended the run,
  // so there was nothing an edge could pick up. `onError: route` is that
  // missing means, and this is the template that uses it.
  { pattern: "Behaviour tree / fallback", templates: ["fallback-chain"] },
  // Listed under #15 as "mesh — the edges would have to appear at run time"
  // until a template proved otherwise: a dynamic fan-out inside a cycle is
  // the n×n exchange, one round per lap.
  { pattern: "Debate / mesh", templates: ["debate"] },
  { pattern: "Swarm / handoff", templates: ["swarm"] },
  // Needs a shared writable space; that is the free state schema. Roadmap #8.
  { pattern: "Blackboard", templates: [] },
];

describe("the library covers the catalogue", () => {
  it("has a template for every pattern that is expressible", () => {
    const missing = CANON.filter(
      (entry) => entry.templates.length > 0 && entry.templates.some((id) => !templateById(id)),
    ).map((entry) => entry.pattern);
    expect(missing).toEqual([]);
  });

  it("keeps every catalogue template in the pattern group", () => {
    const misfiled = CANON.flatMap((entry) => entry.templates).filter(
      (id) => templateGroup(id) !== "pattern",
    );
    expect(misfiled).toEqual([]);
  });

  /**
   * The other direction: a pattern template that is in the library but on no
   * line of the catalogue is either a pattern nobody named, or a work flow
   * filed in the wrong group. Both are worth a look.
   */
  it("claims every pattern template for some line of the catalogue", () => {
    const claimed = new Set(CANON.flatMap((entry) => entry.templates));
    const unclaimed = TEMPLATES.filter(
      (graph) => templateGroup(graph.id) === "pattern" && !claimed.has(graph.id),
    ).map((graph) => graph.id);
    expect(unclaimed).toEqual([]);
  });

  /**
   * `PATTERN_OF` is what the listing and the search show; this table is what
   * the coverage is judged against. Two tables saying different things would
   * mean "do we have ReAct?" has two answers, so they are held equal here.
   */
  it("agrees with the pattern each template advertises", () => {
    const mismatched: string[] = [];
    for (const entry of CANON) {
      for (const id of entry.templates) {
        const advertised = templatePattern(id);
        if (advertised !== entry.pattern) {
          mismatched.push(`${id}: catalogue "${entry.pattern}", library "${advertised}"`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("gives every pattern template a pattern, and no work flow one", () => {
    const wrong = TEMPLATES.filter(
      (graph) =>
        (templateGroup(graph.id) === "pattern") !== (templatePattern(graph.id) !== null),
    ).map((graph) => graph.id);
    expect(wrong).toEqual([]);
  });
});

/**
 * The catalogue's sharpest rule: "every cycle needs three reasons to stop —
 * a success criterion, a round limit and a stagnation check. Building only the
 * first is the classic beginner's mistake."
 *
 * `evaluator-optimizer` had two of the three. A critique that keeps finding
 * things while the draft stops improving would run the loop to its limit, and
 * from outside that is indistinguishable from finishing.
 */
describe("cycles have three ways out", () => {
  it("lets the evaluator loop stop on success, on stagnation and on budget", () => {
    const graph = templateById("evaluator-optimizer")!;
    const out = graph.edges.filter((edge) => edge.from === "critique");
    const reasons = out.map((edge) => edge.label);
    expect(reasons).toEqual([
      "holds",
      "no longer improving",
      "rounds left",
      "budget spent",
    ]);
  });

  it("asks about improvement separately from whether it is good enough", () => {
    const critique = templateById("evaluator-optimizer")!.nodes.find(
      (node) => node.id === "critique",
    )!;
    expect(critique.fields.map((field) => field.name)).toEqual(["done", "progressed"]);
  });
});

/**
 * The search exists for one sentence in the roadmap: "so that 'I'm looking for
 * map-reduce' gets somewhere". What makes it work is not the matching but the
 * field it matches on — somebody after "voting" is not going to guess the name
 * `ensemble-vote`.
 */
describe("searching the library", () => {
  const find = (term: string) => searchGraphs(TEMPLATES, term).map((graph) => graph.id);

  it("finds a template by the pattern it stands for, not just its name", () => {
    expect(find("voting")).toEqual(["ensemble-vote"]);
    expect(find("orchestrator")).toEqual(["map-reduce", "plan-and-execute"]);
    expect(find("ReAct")).toEqual(["react-loop"]);
  });

  it("finds by id, by name and by what the graph is for", () => {
    expect(find("saga-compensation")).toEqual(["saga-compensation"]);
    expect(find("Guardrail before")).toEqual(["guardrail"]);
    // From the example, which is the sentence people recognise.
    expect(find("voucher")).toContain("multi-choice");
  });

  it("ignores case", () => {
    expect(find("SUPERVISOR")).toEqual(find("supervisor"));
  });

  /**
   * An empty term returns everything. A search that hides the library until
   * you type is worse than no search — and this is the case a filter usually
   * gets wrong.
   */
  it("returns the whole library for an empty term", () => {
    expect(searchGraphs(TEMPLATES, "")).toHaveLength(TEMPLATES.length);
    expect(searchGraphs(TEMPLATES, "   ")).toHaveLength(TEMPLATES.length);
  });

  it("returns nothing for a term that matches nothing", () => {
    expect(find("kubernetes")).toEqual([]);
  });
});
