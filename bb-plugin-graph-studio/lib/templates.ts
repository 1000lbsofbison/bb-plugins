// Built-in graphs.
//
// These are the patterns worth learning, expressed as data. Each is a
// starting point the user clones and edits — none of them is special-cased in
// the runtime.
import { END_NODE, START_NODE, graphSchema, type Graph } from "./graph";

type Draft = {
  id: string;
  name: string;
  description: string;
  /** A task this pattern is actually for — see `example` in `graphSchema`. */
  example: string;
  maxSteps?: number;
  maxFanOut?: number;
  nodes: Array<{
    id: string;
    label: string;
    prompt: string;
    kind?: "agent" | "dialog" | "human" | "note" | "subgraph";
    /** `subgraph` only: the graph embedded at this node. */
    graphId?: string;
    skills?: string[];
    /** Exclusive choice (default) or inclusive or. */
    routing?: "first" | "every";
    maxVisits?: number;
    maxTurns?: number;
    maxAttempts?: number;
    /** `route` makes a failure something an edge can pick up. */
    onError?: "stop" | "route";
    // Schema defaults fill the rest, so a template need only name what it
    // actually declares — `options` is meaningless outside an enum.
    fields?: Array<
      Partial<Graph["nodes"][number]["fields"][number]> & { name: string }
    >;
  }>;
  edges: Array<{
    from: string;
    to: string;
    when?: Graph["edges"][number]["when"];
    label?: string;
    fanOutOver?: string;
    /** Handoff: the field the target is read from. */
    handoffFrom?: string;
  }>;
};

function build(draft: Draft): Graph {
  return graphSchema.parse({
    ...draft,
    nodes: draft.nodes,
    edges: draft.edges,
  });
}

/**
 * The harness arc, but as a real graph: Critic routes back to Worker on
 * REWORK. The phase strip in the harness plugin cannot draw that edge; here it
 * is a first-class, visible cycle with its own guard.
 */
const harnessArc: Draft = {
  id: "harness-arc",
  name: "Harness arc (with back edge)",
  description:
    "Explore → Plan → Build → Review → Hand over. The review sends REWORK back into the build — a real cycle instead of a hidden jump backwards.",
  example: "Move the product filter's sorting to the server side",
  maxSteps: 40,
  nodes: [
    {
      id: "explore",
      label: "Explore",
      prompt:
        "Explore the task below. Read the code that matters, name the real obstacle. Build nothing yet.\n\nTask:\n{{input}}",
    },
    {
      id: "plan",
      label: "Plan",
      prompt:
        "Turn this exploration into a concrete implementation plan with numbered steps.\n\nTask:\n{{input}}\n\nExploration:\n{{explore}}",
    },
    {
      id: "worker",
      label: "Build",
      prompt:
        "Carry out this plan. No self-criticism — the next step does that.\n\nPlan:\n{{plan}}\n\nIf there is earlier criticism, work it in:\n{{critic}}",
      maxVisits: 4,
    },
    {
      id: "critic",
      label: "Review",
      prompt:
        "Review the result critically against the plan.\n\nPlan:\n{{plan}}\n\nResult:\n{{worker}}\n\nReason it through at length, then reach a verdict.",
      maxVisits: 4,
      fields: [
        {
          name: "verdict",
          type: "enum",
          options: ["APPROVE", "REWORK", "BLOCK"],
          description: "APPROVE carries on, REWORK goes back to the build, BLOCK stops",
        },
        { name: "reason", type: "string", options: [], description: "one sentence" },
      ],
    },
    {
      id: "gate",
      label: "Human approval",
      kind: "human",
      prompt: "Approve the handover?",
    },
    {
      id: "promote",
      label: "Hand over",
      prompt:
        "Summarise the result for others: what changed, why, and what to watch out for.\n\nResult:\n{{worker}}\n\nReview:\n{{critic}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "explore" },
    { from: "explore", to: "plan" },
    { from: "plan", to: "worker" },
    { from: "worker", to: "critic" },
    {
      from: "critic",
      to: "worker",
      when: { source: "field", key: "critic.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "critic",
      to: END_NODE,
      when: { source: "field", key: "critic.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "critic", to: "gate", label: "APPROVE" },
    { from: "gate", to: "promote" },
    { from: "promote", to: END_NODE },
  ],
};

/** Pattern 2: reflexion loop with an explicit stagnation guard. */
const reflexion: Draft = {
  id: "evaluator-optimizer",
  name: "Evaluator–optimizer loop",
  description:
    "Draft → critique → revise, until the critique finds nothing substantial left or the budget runs out.",
  example: "Write the onboarding text for new colleagues",
  maxSteps: 24,
  nodes: [
    {
      id: "draft",
      label: "Draft",
      prompt: "Write a first draft for:\n\n{{input}}",
    },
    {
      id: "critique",
      label: "Critique",
      prompt:
        "Criticise this draft hard and specifically.\n\n{{draft}}\n\nThen decide two things, separately: whether it holds, and whether the last revision actually improved it. A round that only moved words around did not — say so, and the loop stops instead of spending its budget.\n\nPrevious critique, empty on the first round:\n{{critique}}",
      maxVisits: 5,
      fields: [
        {
          name: "done",
          type: "boolean",
          options: [],
          description: "true when the draft holds",
        },
        {
          // The third reason to stop, and the one loops usually lack: a
          // critique that keeps finding things while the draft stops getting
          // better burns the whole budget and ends as if it had run out of
          // road. Asked as a yes/no about the *last* round, because "is it
          // good yet" and "did it improve" are different questions.
          name: "progressed",
          type: "boolean",
          options: [],
          description: "false when the last revision changed nothing that mattered",
        },
      ],
    },
    {
      id: "revise",
      label: "Revise",
      prompt:
        "Revise the draft along the critique.\n\nDraft:\n{{draft}}\n\nCritique:\n{{critique}}",
      maxVisits: 5,
    },
  ],
  edges: [
    { from: START_NODE, to: "draft" },
    { from: "draft", to: "critique" },
    // Three ways out, in the order they should be asked: it is good enough,
    // it stopped getting better, the budget ran out. Only building the first
    // is the classic mistake — the loop then runs to its limit every time and
    // stopping looks the same as succeeding.
    {
      from: "critique",
      to: END_NODE,
      when: { source: "field", key: "critique.done", op: "equals", value: "true" },
      label: "holds",
    },
    {
      from: "critique",
      to: END_NODE,
      when: { source: "field", key: "critique.progressed", op: "equals", value: "false" },
      label: "no longer improving",
    },
    {
      from: "critique",
      to: "revise",
      when: { source: "output", key: "", op: "visitsBelow", value: "4" },
      label: "rounds left",
    },
    { from: "critique", to: END_NODE, label: "budget spent" },
    { from: "revise", to: "critique" },
  ],
};

/** Pattern 3: a router that picks one of several specialists. */
const router: Draft = {
  id: "routing",
  name: "Routing",
  description:
    "One node classifies the task, a conditional edge sends it to the specialist that fits.",
  example: "Checkout fails on PayPal with a blank error page",
  nodes: [
    {
      id: "classify",
      label: "Classify",
      prompt: "Classify the task below.\n\n{{input}}",
      fields: [
        {
          name: "kind",
          type: "enum",
          options: ["BUG", "FEATURE", "QUESTION"],
          description: "",
        },
      ],
    },
    {
      id: "bug",
      label: "Diagnose",
      prompt: "Diagnose and fix:\n\n{{input}}",
    },
    {
      id: "feature",
      label: "Build",
      prompt: "Build:\n\n{{input}}",
    },
    {
      id: "answer",
      label: "Answer",
      prompt: "Answer this properly, from the code where possible:\n\n{{input}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "classify" },
    {
      from: "classify",
      to: "bug",
      when: { source: "field", key: "classify.kind", op: "equals", value: "BUG" },
      label: "BUG",
    },
    {
      from: "classify",
      to: "feature",
      when: { source: "field", key: "classify.kind", op: "equals", value: "FEATURE" },
      label: "FEATURE",
    },
    { from: "classify", to: "answer", label: "QUESTION" },
    { from: "bug", to: END_NODE },
    { from: "feature", to: END_NODE },
    { from: "answer", to: END_NODE },
  ],
};

/** Pattern 4: fan-out to independent workers, then a join. */
const fanOut: Draft = {
  id: "parallel-sectioning",
  name: "Parallel sectioning",
  description:
    "Three views run independently, a merge node brings them back together.",
  example: "Assess the planned move to Postgres",
  nodes: [
    {
      id: "split",
      label: "Split",
      prompt: "Break the task into three independent views:\n\n{{input}}",
    },
    {
      id: "a",
      label: "View A — correctness",
      prompt: "Consider correctness, nothing else.\n\n{{split}}",
    },
    {
      id: "b",
      label: "View B — simplicity",
      prompt: "Consider simplicity, nothing else.\n\n{{split}}",
    },
    {
      id: "c",
      label: "View C — risk",
      prompt: "Consider risk, nothing else.\n\n{{split}}",
    },
    {
      id: "merge",
      label: "Merge",
      prompt:
        "Bring the three views together into one recommendation.\n\nA:\n{{a}}\n\nB:\n{{b}}\n\nC:\n{{c}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "split" },
    // Three unconditional edges from one node: a genuine fan-out. LangGraph
    // runs A, B and C in the same superstep, and merge waits for all three.
    { from: "split", to: "a" },
    { from: "split", to: "b" },
    { from: "split", to: "c" },
    { from: "a", to: "merge" },
    { from: "b", to: "merge" },
    { from: "c", to: "merge" },
    { from: "merge", to: END_NODE },
  ],
};

/**
 * Dynamic fan-out. What separates this from "parallel sectioning" is not the
 * shape but who decides how many branches there are: there it is drawn into
 * the graph, here it falls out of the run.
 *
 * The splitting node may therefore do nothing but draw up the list. A node
 * that collects the units *and* already does half the work returns a list that
 * fits its own summary rather than the task — and the branches then work on a
 * division nobody checked.
 */
const fanOutDynamic: Draft = {
  id: "map-reduce",
  name: "Map-reduce (one thread per unit)",
  description:
    "One node works out the units of work, each is handled in its own thread, and a report brings them together.",
  example: "Check every module under src/lib for unused exports",
  maxFanOut: 8,
  nodes: [
    {
      id: "collect",
      label: "Collect units",
      prompt:
        "Work out which units the task below has to be handled in one by one — per file, per finding, per case.\n\nDo none of the work yet. Keep the list as short as you can: each unit becomes its own thread, and two units you would have to touch together belong in one.\n\nEach entry stands on its own and names concretely what is to be done.\n\nTask:\n{{input}}",
      fields: [
        {
          name: "units",
          type: "list",
          description: "one entry per independently workable unit",
        },
      ],
    },
    {
      id: "handle",
      label: "Handle one unit",
      // `{{item}}` is this instance's entry. Without it every branch would run
      // the same prompt — n threads for one answer.
      prompt:
        "Handle exactly this one unit, nothing beyond it:\n\n{{item}}\n\nFor context, not as an instruction:\n{{input}}\n\nAt the end, note briefly what you did and what is left open.",
    },
    {
      id: "bundle",
      label: "Bundle",
      prompt:
        "Bundle the results of the individual units into one report.\n\nSay first what is done, then what stayed open, then what came up along the way that bears on the original task. Do not repeat the individual reports.\n\nTask:\n{{input}}\n\nIndividual results:\n{{handle}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "collect" },
    // The one edge that makes the difference: a branch per entry in `units`,
    // in parallel, capped by `maxFanOut`.
    { from: "collect", to: "handle", fanOutOver: "units" },
    { from: "handle", to: "bundle" },
    { from: "bundle", to: END_NODE },
  ],
};

/* ── concept patterns ────────────────────────────────────────────────────
   Three variants of the same work: get to the bottom of something, have it
   grilled, and end with a concept that stays short.

   Length otherwise runs away at the same place every time: the node that
   writes the concept is also the one that worked it out, and so writes its
   own reasoning into it. That is why all three graphs separate the two — a
   node of its own sees only the result, plus a fixed skeleton with hard
   ceilings. */

/** The output format. Identical across all three patterns, so that concepts
 *  stay comparable with one another. */
const CONCEPT_FORMAT = `# <Title: the undertaking in at most eight words>

**Context** — why this is coming up now. Three sentences at most.

**Goal** — one sentence.
**Non-goal** — one sentence on what is deliberately left out.

**Outline** — three to five bullets, one line each, one decision each.

**Impact** — what is touched (packages, processes, interfaces). Five lines at most.

**Risks & open questions** — at most three lines, each with a concrete consequence.

**Next steps** — at most five numbered lines, one line each.`;

/** The distilling node. The skeleton is the same in all three patterns, only
 *  the sources differ. */
function distillPrompt(sources: string): string {
  return `Write the finished concept — Markdown only, nothing before it and nothing after.

Follow this skeleton exactly, with these headings and in this order:

${CONCEPT_FORMAT}

Hard rules:
- 350 words in total at most. Rather cut a line than shorten it.
- No derivation, no discussion of alternatives, no repeating the review. The result only.
- No code blocks, except a single one of at most ten lines if it genuinely earns its place.
- Every bullet is a statement, not a paragraph. If a point needs two lines, it does not belong in the concept.
- Write no meta-sentences about the concept ("This concept describes …").

${sources}`;
}

/** The critic. Same fields in all three patterns, so the back edge looks the
 *  same everywhere. */
const reviewFields: Graph["nodes"][number]["fields"] = [
  {
    name: "verdict",
    type: "enum",
    options: ["APPROVE", "REWORK", "BLOCK"],
    description:
      "APPROVE carries on, REWORK goes back to the draft, BLOCK ends the run",
  },
  {
    name: "reason",
    type: "string",
    options: [],
    description: "one sentence on why",
  },
];

/** Concept pattern 1: an implementation concept for a concrete change. */
const conceptFeature: Draft = {
  id: "concept-feature",
  name: "Concept — feature in this repo",
  description:
    "Explore → Draft → Grill → Distill. For implementation concepts against existing code: the draft reads the code, the review sends REWORK back, and the result is a short concept on a fixed skeleton.",
  example: "Concept for a saved filter view in the catalogue",
  maxSteps: 30,
  nodes: [
    {
      id: "explore",
      label: "Explore",
      skills: ["zoom-out"],
      prompt:
        "Explore the undertaking below in the code. Read the places it touches, name the current state and the real obstacle. Change nothing.\n\nKeep it short: what exists, where it lives, what stands in the way.\n\nUndertaking:\n{{input}}",
    },
    {
      id: "draft",
      label: "Draft",
      skills: ["codebase-design"],
      prompt:
        "Draft how this should be built. Commit to one solution, not three options. Name what you are deliberately not doing.\n\nThis is still the working version: reason at length, a later step does the cutting.\n\nUndertaking:\n{{input}}\n\nExploration:\n{{explore}}\n\nIf there is already a critique, work it in:\n{{grill}}",
      maxVisits: 4,
    },
    {
      id: "grill",
      label: "Grill",
      kind: "dialog",
      skills: ["grilling"],
      prompt:
        "Grill this draft in conversation with me. Find the place where it falls apart: unevidenced assumptions, missed dependencies, effort that in truth sits somewhere else.\n\nOnce we agree, reach the verdict. REWORK if the conversation implies substantial changes — not for wording, which the next step cuts anyway.\n\nUndertaking:\n{{input}}\n\nDraft:\n{{draft}}",
      maxVisits: 4,
      maxTurns: 10,
      fields: reviewFields,
    },
    {
      id: "distill",
      label: "Distill",
      prompt: distillPrompt(
        "Undertaking:\n{{input}}\n\nDraft:\n{{draft}}\n\nReview:\n{{grill}}",
      ),
    },
    {
      id: "approval",
      label: "Human approval",
      kind: "human",
      prompt: "Concept read above — does it hold?",
    },
  ],
  edges: [
    { from: START_NODE, to: "explore" },
    { from: "explore", to: "draft" },
    { from: "draft", to: "grill" },
    {
      from: "grill",
      to: "draft",
      when: { source: "field", key: "grill.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "grill",
      to: END_NODE,
      when: { source: "field", key: "grill.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "grill", to: "distill", label: "APPROVE" },
    { from: "distill", to: "approval" },
    { from: "approval", to: END_NODE },
  ],
};

/** Concept pattern 2: architecture and interface. Here the detour through
 *  several drafts pays: with a module boundary, the second-best option is the
 *  only way to recognise the best one at all. */
const conceptArchitecture: Draft = {
  id: "concept-architecture",
  name: "Concept — architecture & interface",
  description:
    "Frame → Options → Decide → Grill → Distill. For module boundaries and API design: several drafts are set against each other, one wins, and the concept names only that one.",
  example: "How do we separate pricing from the shopping cart?",
  maxSteps: 34,
  nodes: [
    {
      id: "frame",
      label: "Frame & vocabulary",
      skills: ["domain-modeling"],
      prompt:
        "Stake out the frame. What is this module's job, which terms belong to it, which responsibilities sit where today, and where does the boundary to its neighbours run?\n\nNo solution, just the frame.\n\nUndertaking:\n{{input}}",
    },
    {
      id: "options",
      label: "Draft options",
      skills: ["design-an-interface", "codebase-design"],
      prompt:
        "Draft two or three clearly different boundaries for this module — not variants of one idea, but different answers to the question of where the seam runs.\n\nPer option: the interface in a few lines, what it hides, what it puts on the caller.\n\nUndertaking:\n{{input}}\n\nFrame:\n{{frame}}\n\nIf there is already a critique, work it in:\n{{grill}}",
      maxVisits: 4,
    },
    {
      id: "decide",
      label: "Decide",
      skills: ["codebase-design"],
      prompt:
        "Pick one option and justify the choice at the place where the options genuinely differ. Name what the rejected options would have done better — that is the price of the decision.\n\nOptions:\n{{options}}\n\nFrame:\n{{frame}}",
      maxVisits: 4,
    },
    {
      id: "grill",
      label: "Grill",
      kind: "dialog",
      skills: ["grilling"],
      prompt:
        "Grill this decision in conversation with me. Check above all: does the interface hold up for the case that arrives in six months? Was an option rejected out of convenience rather than for reasons?\n\nA module boundary is a decision, not a derivation — ask me where you are unsure.\n\nOnce we agree, reach the verdict. REWORK goes back to the options.\n\nFrame:\n{{frame}}\n\nDecision:\n{{decide}}",
      maxVisits: 4,
      maxTurns: 10,
      fields: reviewFields,
    },
    {
      id: "distill",
      label: "Distill",
      prompt: distillPrompt(
        "Write the concept for the chosen option only. The rejected options appear at most as one line under \"Risks & open questions\".\n\nUndertaking:\n{{input}}\n\nDecision:\n{{decide}}\n\nReview:\n{{grill}}",
      ),
    },
    {
      id: "approval",
      label: "Human approval",
      kind: "human",
      prompt: "Concept read above — does the chosen boundary hold?",
    },
  ],
  edges: [
    { from: START_NODE, to: "frame" },
    { from: "frame", to: "options" },
    { from: "options", to: "decide" },
    { from: "decide", to: "grill" },
    {
      from: "grill",
      to: "options",
      when: { source: "field", key: "grill.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "grill",
      to: END_NODE,
      when: { source: "field", key: "grill.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "grill", to: "distill", label: "APPROVE" },
    { from: "distill", to: "approval" },
    { from: "approval", to: END_NODE },
  ],
};

/** Concept pattern 3: a domain concept without code. The draft researches
 *  instead of reading — otherwise the same flow, so that the result has the
 *  same shape as the other two. */
const conceptDomain: Draft = {
  id: "concept-domain",
  name: "Concept — domain",
  description:
    "Research → Draft → Grill → Distill. For product and process concepts with no code involved: the groundwork comes from research rather than the repo, and the skeleton at the end is the same.",
  example: "Concept for the returns process in the customer account",
  maxSteps: 30,
  nodes: [
    {
      id: "research",
      label: "Research",
      skills: ["research"],
      prompt:
        "Gather the groundwork for the undertaking below: how is this solved today, who is involved, which figures or requirements hold up?\n\nKeep evidence and assumption explicitly apart.\n\nUndertaking:\n{{input}}",
    },
    {
      id: "draft",
      label: "Draft",
      prompt:
        "Draft the domain concept on this groundwork. Commit to one way and name what is deliberately left out.\n\nThis is the working version: reason at length, the cutting comes later.\n\nUndertaking:\n{{input}}\n\nResearch:\n{{research}}\n\nIf there is already a critique, work it in:\n{{grill}}",
      maxVisits: 4,
    },
    {
      id: "grill",
      label: "Grill",
      kind: "dialog",
      skills: ["grilling"],
      prompt:
        "Grill this draft in conversation with me. Check especially: which assumption carries the whole thing, and what happens if it is wrong? Who would have to go along with it for this to work, and were they asked?\n\nOnce we agree, reach the verdict.\n\nUndertaking:\n{{input}}\n\nDraft:\n{{draft}}",
      maxVisits: 4,
      maxTurns: 10,
      fields: reviewFields,
    },
    {
      id: "distill",
      label: "Distill",
      prompt: distillPrompt(
        "Undertaking:\n{{input}}\n\nDraft:\n{{draft}}\n\nReview:\n{{grill}}",
      ),
    },
    {
      id: "approval",
      label: "Human approval",
      kind: "human",
      prompt: "Concept read above — does it hold?",
    },
  ],
  edges: [
    { from: START_NODE, to: "research" },
    { from: "research", to: "draft" },
    { from: "draft", to: "grill" },
    {
      from: "grill",
      to: "draft",
      when: { source: "field", key: "grill.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "grill",
      to: END_NODE,
      when: { source: "field", key: "grill.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "grill", to: "distill", label: "APPROVE" },
    { from: "distill", to: "approval" },
    { from: "approval", to: END_NODE },
  ],
};

/* ── development patterns ────────────────────────────────────────────────
   Concept → Plan → Build → Test, in three shapes.

   The decisive edge is the same in all of them: the test run sends red back
   into the build. That is the difference between "the agent wrote tests" and
   "the tests pass" — a worker checking its own result will happily explain a
   red run away. A test node of its own with a declared field cannot, because
   it may return nothing but the field. */

/** Result of a test run. `status` carries the back edge, `failing` makes sure
 *  the build learns *what* was red instead of guessing again. */
const testFields: Graph["nodes"][number]["fields"] = [
  {
    name: "status",
    type: "enum",
    options: ["GREEN", "RED"],
    description: "GREEN only if the run actually completed",
  },
  {
    name: "failing",
    type: "string",
    options: [],
    description: "the failing tests, otherwise empty",
  },
];

/** The test node's skeleton. Deliberately pedantic: the most common way to
 *  lose this node is a worker that never runs the test command and reports
 *  GREEN anyway. */
const TEST_PROMPT = `Run the tests — actually run them, do not assess them.

Take the project's test command (README, package.json, CLAUDE.md). If lint and typecheck belong to the project too, run them as well.

Report GREEN only if the run actually completed. A skipped, commented-out or never-started test is RED. Repair nothing — that is the next step.

On RED, give under \`failing\` the failing tests with the gist of the error, short enough for the build to work from.

What was built:
{{build}}`;

/** Development pattern 1: the full arc for a new feature. */
const devTdd: Draft = {
  id: "dev-tdd",
  name: "Development — concept → plan → build → test",
  description:
    "The full arc for a new feature: a short concept, reviewed, turned into a step plan, built test-first, and let through only once the test run is genuinely green.",
  example: "Make voucher codes redeemable in the shopping cart",
  maxSteps: 60,
  nodes: [
    {
      id: "concept",
      label: "Concept",
      skills: ["codebase-design"],
      prompt: `Read the code this touches and write a short implementation concept — Markdown only, on this skeleton, at most 350 words:

${CONCEPT_FORMAT}

Change nothing yet.

Undertaking:
{{input}}

If there is already a critique, work it in:
{{grill}}`,
      maxVisits: 4,
    },
    {
      id: "grill",
      label: "Grill the concept",
      kind: "dialog",
      skills: ["grilling"],
      prompt:
        "Grill this concept in conversation with me, before it becomes code. Find the unevidenced assumption, the missed dependency, the effort that in truth sits somewhere else.\n\nThis is the point where a question is still cheap — after it, we build.\n\nOnce we agree, reach the verdict. REWORK only for substance.\n\nUndertaking:\n{{input}}\n\nConcept:\n{{concept}}",
      maxVisits: 4,
      maxTurns: 10,
      fields: reviewFields,
    },
    {
      id: "plan",
      label: "Plan",
      skills: ["tdd"],
      prompt:
        "Turn the concept into a step plan.\n\nEach step is small enough to be committed on its own and names the test that secures it. Steps that are mere trimming, you cut.\n\nNumber them, at most two lines per step.\n\nConcept:\n{{concept}}\n\nReview:\n{{grill}}",
    },
    {
      id: "build",
      label: "Build (TDD)",
      skills: ["tdd"],
      prompt:
        "Build this plan test-first: the failing test, then the code that makes it pass, then tidy up. Step by step.\n\nNo self-assessment at the end — reviewing and testing are the next nodes' job.\n\nPlan:\n{{plan}}\n\nIf a test run failed, fix exactly that first:\n{{test}}\n\nIf there is criticism from the review, work it in:\n{{review}}",
      maxVisits: 6,
    },
    {
      id: "test",
      label: "Test",
      prompt: TEST_PROMPT,
      maxVisits: 6,
      fields: testFields,
    },
    {
      id: "review",
      label: "Review",
      skills: ["code-review"],
      prompt:
        "Review the build against the plan. Green tests do not mean the right thing was built: is a plan step missing, is a test tautological, was an edge case quietly dropped?\n\nThen reach a verdict. REWORK goes back into the build.\n\nPlan:\n{{plan}}\n\nBuild:\n{{build}}\n\nTest run:\n{{test}}",
      maxVisits: 4,
      fields: reviewFields,
    },
    {
      id: "approval",
      label: "Human approval",
      kind: "human",
      prompt: "Tests green, review passed — take it?",
    },
    {
      id: "handover",
      label: "Hand over",
      prompt:
        "Summarise for others what changed and why, plus what came up while testing. Ten lines at most.\n\nConcept:\n{{concept}}\n\nBuild:\n{{build}}\n\nReview:\n{{review}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "concept" },
    { from: "concept", to: "grill" },
    {
      from: "grill",
      to: "concept",
      when: { source: "field", key: "grill.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "grill",
      to: END_NODE,
      when: { source: "field", key: "grill.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "grill", to: "plan", label: "APPROVE" },
    { from: "plan", to: "build" },
    { from: "build", to: "test" },
    {
      from: "test",
      to: "build",
      when: { source: "field", key: "test.status", op: "equals", value: "RED" },
      label: "RED",
    },
    { from: "test", to: "review", label: "GREEN" },
    {
      from: "review",
      to: "build",
      when: { source: "field", key: "review.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "review",
      to: END_NODE,
      when: { source: "field", key: "review.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "review", to: "approval", label: "APPROVE" },
    { from: "approval", to: "handover" },
    { from: "handover", to: END_NODE },
  ],
};

/** Development pattern 2: the same arc for a bug. Instead of a concept there
 *  is a diagnosis at the start, and the first test is the one that reproduces
 *  the bug — without it there is no evidence the fix fixed anything. */
const devBugfix: Draft = {
  id: "dev-bugfix",
  name: "Development — bug: diagnose → repro test → fix → test",
  description:
    "For fixing bugs: reproduce and evidence the cause first, then a red test that pins the bug down, then the fix. The test run sends red back.",
  example: "The wishlist loses all entries after logging in",
  maxSteps: 50,
  nodes: [
    {
      id: "diagnose",
      label: "Diagnose",
      skills: ["diagnosing-bugs"],
      prompt:
        "Diagnose the bug below. Reproduce it, narrow it down, evidence the cause at the place in the code.\n\nFix nothing yet — a cause that merely sounds plausible is not one.\n\nBug:\n{{input}}",
    },
    {
      id: "repro",
      label: "Reproduction test",
      skills: ["tdd"],
      prompt:
        "Write exactly one test that pins down the diagnosed bug and fails right now — against the behaviour, not the implementation.\n\nDo not change production code. Confirm the test is red for the right reason.\n\nDiagnosis:\n{{diagnose}}",
    },
    {
      id: "build",
      label: "Fix",
      skills: ["tdd"],
      prompt:
        "Fix the cause until the reproduction test is green. The cause, not the symptom.\n\nDiagnosis:\n{{diagnose}}\n\nReproduction test:\n{{repro}}\n\nIf a test run failed, fix exactly that first:\n{{test}}",
      maxVisits: 6,
    },
    {
      id: "test",
      label: "Test",
      prompt: TEST_PROMPT,
      maxVisits: 6,
      fields: testFields,
    },
    {
      id: "review",
      label: "Review",
      skills: ["code-review"],
      prompt:
        "Review the fix. Two questions: is the cause fixed, or only the path it showed up on? And does the reproduction test pin the bug down well enough that it would go red again next time?\n\nThen reach a verdict.\n\nDiagnosis:\n{{diagnose}}\n\nFix:\n{{build}}\n\nTest run:\n{{test}}",
      maxVisits: 4,
      fields: reviewFields,
    },
    {
      id: "approval",
      label: "Human approval",
      kind: "human",
      prompt: "Bug fixed and secured by a test — take it?",
    },
  ],
  edges: [
    { from: START_NODE, to: "diagnose" },
    { from: "diagnose", to: "repro" },
    { from: "repro", to: "build" },
    { from: "build", to: "test" },
    {
      from: "test",
      to: "build",
      when: { source: "field", key: "test.status", op: "equals", value: "RED" },
      label: "RED",
    },
    { from: "test", to: "review", label: "GREEN" },
    {
      from: "review",
      to: "build",
      when: { source: "field", key: "review.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "review",
      to: END_NODE,
      when: { source: "field", key: "review.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "review", to: "approval", label: "APPROVE" },
    { from: "approval", to: END_NODE },
  ],
};

/** Development pattern 3: rebuilding in small steps. The cycle here does not
 *  run over a failure but over progress — a step is built, tested, and the
 *  graph comes back for as long as steps are open. Exactly what a DAG cannot
 *  express. */
const devRefactor: Draft = {
  id: "dev-refactor",
  name: "Development — refactor in small steps",
  description:
    "A rebuild plan broken into tiny steps, then step by step: build, test, back to the next step. Behaviour has to stay unchanged throughout.",
  example: "Pull price formatting out of the components into a module",
  maxSteps: 80,
  nodes: [
    {
      id: "plan",
      label: "Rebuild plan",
      skills: ["request-refactor-plan", "codebase-design"],
      prompt:
        "Draw up a rebuild plan for the undertaking below.\n\nEach step is committable on its own, leaves behaviour unchanged and keeps the tests green. Number the steps and keep each to one line.\n\nChange nothing yet.\n\nUndertaking:\n{{input}}\n\nIf there is a critique, work it in:\n{{grill}}",
      maxVisits: 3,
    },
    {
      id: "grill",
      label: "Grill the plan",
      kind: "dialog",
      skills: ["grilling"],
      prompt:
        "Grill this rebuild plan in conversation with me. Is every step really behaviour-neutral, or does one smuggle a behaviour change along? Is there a step that is in truth three?\n\nOnce we agree, reach the verdict.\n\nPlan:\n{{plan}}",
      maxVisits: 3,
      maxTurns: 8,
      fields: reviewFields,
    },
    {
      id: "step",
      label: "Next step",
      skills: ["tdd"],
      prompt:
        "Build the next open step of the plan — exactly one, not two.\n\nBehaviour stays unchanged: the existing tests are the safety net, new tests only where the rebuild exposes a seam that could not be tested before.\n\nSay at the start of your answer which step you are building.\n\nPlan:\n{{plan}}\n\nDone so far:\n{{progress}}\n\nIf the last test run was red, fix that first:\n{{test}}",
      maxVisits: 12,
    },
    {
      id: "test",
      label: "Test",
      prompt: TEST_PROMPT.replace("{{build}}", "{{step}}"),
      maxVisits: 14,
      fields: testFields,
    },
    {
      id: "progress",
      label: "Progress",
      prompt:
        "Keep the books on the rebuild. List the plan's finished steps, one line each, then the open ones.\n\nDecide whether all steps are done.\n\nPlan:\n{{plan}}\n\nMost recently built:\n{{step}}\n\nTest run:\n{{test}}\n\nState so far:\n{{progress}}",
      maxVisits: 12,
      fields: [
        {
          name: "done",
          type: "boolean",
          options: [],
          description: "true when no step of the plan is open any more",
        },
        {
          name: "open",
          type: "number",
          options: [],
          description: "number of steps still open",
        },
      ],
    },
    {
      id: "approval",
      label: "Human approval",
      kind: "human",
      prompt: "Rebuild complete, tests green — take it?",
    },
  ],
  edges: [
    { from: START_NODE, to: "plan" },
    { from: "plan", to: "grill" },
    {
      from: "grill",
      to: "plan",
      when: { source: "field", key: "grill.verdict", op: "equals", value: "REWORK" },
      label: "REWORK",
    },
    {
      from: "grill",
      to: END_NODE,
      when: { source: "field", key: "grill.verdict", op: "equals", value: "BLOCK" },
      label: "BLOCK",
    },
    { from: "grill", to: "step", label: "APPROVE" },
    { from: "step", to: "test" },
    {
      from: "test",
      to: "step",
      when: { source: "field", key: "test.status", op: "equals", value: "RED" },
      label: "RED",
    },
    { from: "test", to: "progress", label: "GREEN" },
    {
      from: "progress",
      to: "approval",
      when: { source: "field", key: "progress.done", op: "equals", value: "true" },
      label: "all steps done",
    },
    { from: "progress", to: "step", label: "carry on" },
    { from: "approval", to: END_NODE },
  ],
};

/* ── patterns for the very beginning: from a thought to a document ────────
   The two below came out of real work, not off a drawing board. Both start
   *before* there is a task at all. That is what separates them from the
   concept patterns above, which assume someone already wrote one. */

/**
 * For the raw thought. The interview node opens up the design tree rather than
 * walking a finished plan — and the declared `format` field decides which
 * skeleton the closing node uses.
 *
 * The back edge is the instructive part: `distill` may send back into the
 * interview, but only with *the one* question that is missing (`reason`).
 * Without that field the second interview would start from nothing and reopen
 * everything already agreed.
 */
const ideaToConcept: Draft = {
  id: "idea-to-concept",
  name: "Idea → concept",
  description:
    "For the raw thought that is not yet a task. An interview sharpens it and decides the target format (concept, epic, specification), then draft and distill. No repo needed.",
  example: "Something about reminding people of abandoned orders",
  maxSteps: 24,
  nodes: [
    {
      id: "sharpen",
      label: "Sharpen",
      kind: "dialog",
      skills: ["grilling"],
      maxTurns: 10,
      prompt:
        "Apply the `grilling` skill first. What is being grilled is, exceptionally, not a finished plan but a raw thought of mine — so the design tree you would walk is not yet spread out. That is precisely the job: spread it out by questioning me. Solve nothing, draft nothing.\n\nThe branches to question along:\n\n1. Occasion — who is bothered by how things are now, and how would you notice?\n2. Goal — how would you recognise that it is solved?\n3. Boundary — what expressly does NOT belong to it?\n4. Format — do I need a CONCEPT, an EPIC or a SPECIFICATION at the end?\n\nDeviate from these where my answers suggest it. An evasive answer is the point at which you dig in — that is what this step is for.\n\nStopping: once all four branches stand, you stop. A fifth branch that occurs to me while writing is cheaper than ten questions now.\n\nSecond round: if something stands under \"Missing question\", then we have already had this interview and the distilling found the result resting on an unchecked assumption. Then ask exactly that question first and reopen nothing we already agreed on. If that place is empty, this is the first round and the flow above applies.\n\nMissing question:\n{{distill.reason}}\n\nYour closing message is the sharpened task — at most 150 words, in my words, not in consultant-speak. From here on it replaces my raw text. Name the title and the chosen target format in it explicitly — the following steps get only this text to read, not our conversation.\n\nMy thought:\n{{input}}",
      fields: [
        {
          name: "format",
          type: "enum",
          options: ["CONCEPT", "EPIC", "SPECIFICATION"],
          description:
            "CONCEPT = justify a decision. EPIC = cut up the work. SPECIFICATION = pin down behaviour.",
        },
        {
          name: "title",
          type: "string",
          description: "one line naming the undertaking",
        },
      ],
    },
    {
      id: "draft",
      label: "Draft",
      prompt:
        "Work out the sharpened task. Commit to one answer, not three options. Name what you deliberately leave out.\n\nThis is the working version: reason at length, the cutting comes after. Where you assume something, write that it is an assumption.\n\nSharpened task:\n{{sharpen}}\n\nOriginal thought, as context only — the sharpened version governs:\n{{input}}",
    },
    {
      id: "distill",
      label: "Distill",
      prompt:
        "Write the result — Markdown only, with no accompanying text; the JSON block of the answer format below comes after it and is not part of the result.\n\nThe target format is: {{sharpen.format}}. Take exactly this skeleton — and only this one:\n\nCONCEPT (max. 350 words)\n## Problem\n## Solution\n## Boundary\n## Risks & open questions\n\nEPIC (max. 400 words)\n## Goal\n## Value\n## Scope\n## Acceptance criteria\n## Breakdown (list of possible stories, one line each)\n\nSPECIFICATION (max. 500 words)\n## Purpose\n## Behaviour (case → expected result)\n## Edge cases\n## Not covered\n\nHard rules:\n- Every bullet is a statement, not a paragraph. If a point needs two lines, it does not belong here.\n- No derivation, no discussion of alternatives, no meta-sentences (\"This concept describes …\").\n- Rather cut a line than shorten it.\n- At most one code block, at most ten lines, and only if it genuinely earns its place.\n\nThen set `gap`: OPEN only if, while writing, you notice that a question was never asked in the interview and the result therefore rests on an unchecked assumption. Not for wording, not for details — the back edge costs a fresh interview.\n\nSharpened task:\n{{sharpen}}\n\nDraft:\n{{draft}}",
      fields: [
        {
          name: "gap",
          type: "enum",
          options: ["NONE", "OPEN"],
          description: "OPEN goes back to the interview, NONE goes to approval",
        },
        {
          name: "reason",
          type: "string",
          description: "on OPEN: the one question that is missing",
        },
      ],
    },
    {
      id: "approval",
      label: "Human approval",
      kind: "human",
      prompt: "Result read above — does it hold?",
    },
  ],
  edges: [
    { from: START_NODE, to: "sharpen" },
    { from: "sharpen", to: "draft" },
    { from: "draft", to: "distill" },
    {
      from: "distill",
      to: "sharpen",
      when: { source: "field", key: "distill.gap", op: "equals", value: "OPEN" },
      label: "OPEN",
    },
    { from: "distill", to: "approval" },
    { from: "approval", to: END_NODE },
  ],
};

/**
 * Dictating in waves. The person talks, the agent holds the draft — and is
 * expressly allowed to invent *nothing*.
 *
 * This is the counterpart to every other pattern here: elsewhere a worker is
 * meant to contribute judgement of its own, here that is exactly the failure.
 * An agent that "helpfully adds" while taking dictation produces a document in
 * which the author can no longer tell their own statements from the invented
 * ones. Hence the hard rules in the prompt and a review node of its own that
 * may only *ask* — criticism comes on request and never as text in the
 * document.
 *
 * The one rule this template may *not* make is "answer with the document and
 * nothing else": a node with declared fields gets `fieldContract` appended, so
 * that sentence told the worker to break the contract it is judged by, and
 * `parseFields` would fail the node on every attempt. The document comes
 * first, the JSON block after it, and the prompt says so itself.
 */
const conceptWaves: Draft = {
  id: "concept-waves",
  name: "Concept — in waves (only what was said)",
  description:
    "Concept work in waves on a fixed skeleton. Each input is worked in, and afterwards the full Markdown version stands there. The agent phrases and orders, but does not widen the range of topics. A review round asks questions on request — and only questions.",
  example: "Concept for the 2027 assortment roadmap, I'll dictate it in waves",
  maxSteps: 80,
  nodes: [
    {
      id: "version",
      label: "Work in",
      // Not a cycle guard in the usual sense but the expected length of a
      // dictation: 20 waves, plus the up to 6 returns from a review round,
      // which come back into this node without a new wave. Counting only the
      // waves would have cut a dictation short after fourteen of them for
      // anyone who used the review. `maxSteps` catches the rest.
      maxVisits: 26,
      prompt:
        "You are carrying a concept document through several waves. I dictate in waves, you hold the version.\n\nSkeleton — exactly these sections, in this order, and no others:\n## Problem\n## Solution\n## Boundary\n## Open points\n\nIf the repo holds a template under `documentation/templates/concept.md`, read it first; then it applies instead of the skeleton above.\n\nVersion so far (empty = first wave):\n{{version}}\n\nNew input from me (after a review round this is still the dictation from before it; whatever of it is already in the version, you leave as it stands):\n{{dictation}}\n\nFirst wave — governs only if nothing stands above:\n{{input}}\n\nAnswers from the last review round (may be empty; whatever of it is already in the version, you ignore):\n{{review}}\n\nYour job: work the new input into the version. You may phrase, order, pull duplicates together, turn speech into clear statements and resolve contradictions with the previous version. You may not widen the range of topics.\n\nHard rules:\n- Only what I said is in there. No additions from expertise, no best practices, no examples, no technology, no side topics I did not name myself.\n- No placeholders, no \"open\", no \"TBD\", no empty sections. A section without content does not appear.\n- No meta-sentences about the document, no introduction, no conclusion, no changelog.\n- If a new statement contradicts an old one, the new one applies. The old one is replaced, not set beside it.\n- If I say something does not belong, you remove it entirely and do not bring it back.\n- Under \"Open points\" stands only what I myself named as open.\n- If you notice something missing: keep it to yourself. That is what the review round is for, and I ask for it.\n\nOutput: the complete Markdown of the new version, and no accompanying text — no preamble, no closing remark. The JSON block of the answer format below is the one exception; it comes after the document and is not part of it.\n\nIn that block set `intent` according to what my input calls for:\n- REVIEW — I am asking for gaps, for criticism, for your opinion, for what is missing.\n- DONE — I say that is enough.\n- CONTINUE — everything else, including plain adding, correcting or excluding. When in doubt, CONTINUE.",
      fields: [
        {
          name: "intent",
          type: "enum",
          options: ["CONTINUE", "REVIEW", "DONE"],
          description: "CONTINUE = next wave. REVIEW = grilling round. DONE = end.",
        },
      ],
    },
    {
      id: "dictation",
      label: "Next wave",
      kind: "human",
      maxVisits: 20,
      prompt:
        "Current version:\n\n{{version}}\n\nNext wave: add, correct, exclude — or ask for gaps (\"what's missing?\"), or \"done\".",
    },
    {
      id: "review",
      label: "Review (questions only)",
      kind: "dialog",
      skills: ["grilling"],
      maxVisits: 6,
      // Five questions per round is what the prompt asks for; twelve turns is
      // what the schema default would have allowed.
      maxTurns: 10,
      prompt:
        "The subject is the version below.\n\nYou ask questions and nothing else. You write no text for the document, propose no solution and do not assert what is missing.\n\nWhat to question along:\n- Statements in the version that are unclear, ambiguous or contradictory.\n- Places where the version rests on an assumption I never voiced.\n- Topics you believe are missing: ask whether they are relevant — not that they are missing.\n\nAssume I have a picture of the implementation and the system that you do not. Often a topic is settled for that reason. One question per point, at most five per round. \"Not relevant\" is a complete answer — do not dig there.\n\nYour closing message: my answers only, in my words, as bullets. No question I did not answer. No addition of your own. If I ruled something out as not relevant, write that down too, so the topic does not come back.\n\nVersion:\n{{version}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "version" },
    {
      from: "version",
      to: "review",
      when: { source: "field", key: "version.intent", op: "equals", value: "REVIEW" },
      label: "REVIEW",
    },
    {
      from: "version",
      to: END_NODE,
      when: { source: "field", key: "version.intent", op: "equals", value: "DONE" },
      label: "DONE",
    },
    { from: "version", to: "dictation", label: "CONTINUE" },
    { from: "dictation", to: "version" },
    { from: "review", to: "version" },
  ],
};

/**
 * The reason subgraphs exist: "concept first, then build it" is two flows, not
 * one. Until now the nodes of `idea-to-concept` would have had to be copied in
 * here — and from the first improvement there, two versions maintained.
 *
 * The bargain a subgraph strikes is visible too: `plan` reads `{{distill}}`, a
 * node *from the child graph*. That works because an embedded graph shares the
 * same state — and precisely for that reason node ids have to be unique across
 * the boundary, which the validator checks.
 */
const projectEndToEnd: Draft = {
  id: "project-end-to-end",
  name: "Project — concept and build",
  description:
    "Embeds \"Idea → concept\" as a subgraph and then builds its result: plan, build, test. Red goes back into the build. For the undertaking that has no task yet and should end with running code.",
  example: "Customers should be able to cancel an order themselves",
  maxSteps: 60,
  nodes: [
    {
      id: "concept",
      label: "Work out the concept",
      kind: "subgraph",
      graphId: "idea-to-concept",
      prompt: "",
    },
    {
      id: "plan",
      label: "Plan",
      skills: ["codebase-design", "tdd"],
      prompt:
        "Lay the build of the following concept out in small steps. Each step runs on its own and is testable on its own — no step that only makes sense together with the next.\n\nRead the code it touches first. If the code contradicts the concept, say so here and plan by the code.\n\nConcept:\n{{distill}}",
    },
    {
      id: "build",
      label: "Build",
      skills: ["tdd"],
      maxVisits: 5,
      prompt:
        "Build the plan. Keep to the steps and their order.\n\nPlan:\n{{plan}}\n\nIf there is a test finding below, fix that first — the cause, not the symptom:\n{{test}}",
    },
    {
      id: "test",
      label: "Test",
      maxVisits: 5,
      prompt:
        "Run the project's tests and typecheck. Report what passes and what does not.\n\nDo not assess the work, only the outcome of the test run. `status` is RED as soon as anything fails — even if the change otherwise looks right.",
      fields: [
        {
          name: "status",
          type: "enum",
          options: ["GREEN", "RED"],
          description: "GREEN = everything passes. RED = something fails.",
        },
        {
          name: "finding",
          type: "string",
          description: "on RED: what fails, in one sentence",
        },
      ],
    },
    {
      // Not `approval`: that node already exists in the embedded graph, and
      // shared state means shared ids. The validator reported exactly this
      // before the template had ever run.
      id: "signoff",
      label: "Human sign-off",
      kind: "human",
      prompt: "Concept, build and test run read above — does that work?",
    },
  ],
  edges: [
    { from: START_NODE, to: "concept" },
    { from: "concept", to: "plan" },
    { from: "plan", to: "build" },
    { from: "build", to: "test" },
    {
      from: "test",
      to: "build",
      when: { source: "field", key: "test.status", op: "equals", value: "RED" },
      label: "RED",
    },
    { from: "test", to: "signoff", label: "GREEN" },
    { from: "signoff", to: END_NODE },
  ],
};

/* ── pattern templates, English ─────────────────────────────────────────────
 *
 * These six spell out control-flow patterns the engine can express but no
 * shipped graph demonstrated.
 */

/**
 * Exclusive choice that comes back together. `router` ends in three dead ends,
 * which is fine for a handover but wrong whenever the branches produce
 * something a later step needs. The difference between the two is worth one
 * template.
 */
const simpleMerge: Draft = {
  id: "simple-merge",
  name: "Exclusive choice, merged",
  description:
    "One classifier, three specialists, one report. Unlike `router` the branches converge again, so whatever the chosen branch produced is still there at the end.",
  example: "Decide whether the failing checkout is a bug, a gap or a question, then write it up",
  maxSteps: 20,
  nodes: [
    {
      id: "classify",
      label: "Classify",
      prompt:
        "Classify the following request. Explain your reasoning, then decide.\n\nRequest:\n{{input}}",
      fields: [
        {
          name: "kind",
          type: "enum",
          options: ["BUG", "FEATURE", "QUESTION"],
          description: "which specialist should take this",
        },
      ],
    },
    {
      id: "bug",
      label: "Investigate",
      prompt: "Track down the cause. Do not fix anything yet.\n\nRequest:\n{{input}}",
    },
    {
      id: "feature",
      label: "Shape",
      prompt: "Sketch how this would be built, in numbered steps.\n\nRequest:\n{{input}}",
    },
    {
      id: "answer",
      label: "Answer",
      prompt: "Answer the question directly, from the code where possible.\n\nRequest:\n{{input}}",
    },
    {
      id: "report",
      label: "Write up",
      prompt:
        "Write up whichever of these ran, in the reader's own terms. Empty sections mean that branch was not taken; leave them out.\n\nRequest:\n{{input}}\n\nInvestigation:\n{{bug}}\n\nShape:\n{{feature}}\n\nAnswer:\n{{answer}}",
    },
  ],
  edges: [
    { from: "__start__", to: "classify" },
    { from: "classify", to: "bug", when: { source: "field", key: "classify.kind", op: "equals", value: "BUG" } },
    { from: "classify", to: "feature", when: { source: "field", key: "classify.kind", op: "equals", value: "FEATURE" } },
    { from: "classify", to: "answer" },
    { from: "bug", to: "report" },
    { from: "feature", to: "report" },
    { from: "answer", to: "report" },
    { from: "report", to: "__end__" },
  ],
};

/**
 * Voting. Three attempts at the *same* task, then one node reconciles them.
 * Worth its cost where a single pass is plausible but unreliable, and where
 * disagreement between the three is itself the signal.
 */
const ensembleVote: Draft = {
  id: "ensemble-vote",
  name: "Ensemble vote",
  description:
    "Three independent attempts at the same question, then a tally. Where they agree you can trust the answer; where they differ, that disagreement is the finding.",
  example: "Decide whether this migration can run without downtime",
  maxSteps: 20,
  nodes: [
    {
      id: "frame",
      label: "Frame",
      prompt:
        "State the question precisely enough that three people answering it separately would answer the same question. Do not answer it.\n\nRequest:\n{{input}}",
    },
    {
      id: "cautious",
      label: "Cautious take",
      prompt:
        "Answer this question, weighting what could go wrong.\n\nQuestion:\n{{frame}}",
    },
    {
      id: "direct",
      label: "Direct take",
      prompt:
        "Answer this question as directly as the evidence allows. Do not hedge.\n\nQuestion:\n{{frame}}",
    },
    {
      id: "contrarian",
      label: "Contrarian take",
      prompt:
        "Answer this question by arguing the case most people would miss.\n\nQuestion:\n{{frame}}",
    },
    {
      id: "tally",
      label: "Tally",
      prompt:
        "Three answers to the same question. Say where they agree, where they differ, and which reading the evidence supports. Name the disagreement rather than averaging it away.\n\nQuestion:\n{{frame}}\n\nCautious:\n{{cautious}}\n\nDirect:\n{{direct}}\n\nContrarian:\n{{contrarian}}",
      fields: [
        {
          name: "agreement",
          type: "enum",
          options: ["UNANIMOUS", "SPLIT", "CONTESTED"],
          description: "how far the three converged",
        },
      ],
    },
  ],
  edges: [
    { from: "__start__", to: "frame" },
    { from: "frame", to: "cautious" },
    { from: "frame", to: "direct" },
    { from: "frame", to: "contrarian" },
    { from: "cautious", to: "tally" },
    { from: "direct", to: "tally" },
    { from: "contrarian", to: "tally" },
    { from: "tally", to: "__end__" },
  ],
};

/**
 * Debate. Several positions answer the same question at once, a moderator
 * reads the round, and in the next round the positions answer *each other*.
 *
 * What separates it from the vote: there the three takes never see one
 * another, and disagreement is only tallied. Here it is worked — a position
 * has to answer the strongest point against it, or concede.
 *
 * The shape is a fan-out inside a cycle, and it is built the one way the
 * engine allows. The moderator cannot fan out itself: a fanning edge carries
 * no condition and a fanning node has no second edge. So the moderator only
 * routes — verdict, or another round — and a note node holds the fan-out edge
 * back into the positions. No join is needed either: the branches of a
 * dynamic fan-out finish in one superstep, so the moderator runs once per
 * round. A static fan-out with a join would not work here, because joins
 * inside cycles are not recognised — see `joinSources`.
 */
const debate: Draft = {
  id: "debate",
  name: "Debate",
  description:
    "Several positions answer the same question, then answer each other. A moderator reads every round and stops when the positions have converged, or when the disagreement is fully mapped and stops moving.",
  example: "Should we split the checkout service out of the monolith?",
  maxSteps: 40,
  maxFanOut: 5,
  nodes: [
    {
      id: "frame",
      label: "Frame",
      prompt:
        "State the question precisely enough that people arguing from different positions would argue about the same thing. Do not answer it.\n\nThen name the positions worth hearing — at most five, usually three. Each entry is one stance, written as a sentence someone could hold and defend, not a topic. Two positions that would say the same thing are one.\n\nRequest:\n{{input}}",
      fields: [
        {
          name: "positions",
          type: "list",
          description: "one stance per participant",
        },
      ],
    },
    {
      id: "speak",
      label: "Speak",
      // `{{item}}` is this participant's stance; `{{speak}}` is the previous
      // round — every branch of the last visit, own statement included.
      prompt:
        "You argue this position:\n\n{{item}}\n\nQuestion:\n{{frame}}\n\nWhat the positions said in the last round — empty in the first:\n{{speak}}\n\nWhat the moderator made of it — empty in the first:\n{{moderate}}\n\nIn the first round, make your case. In a later round, answer the strongest point made against you; concede what you must, and say so plainly. Do not repeat yourself, and do not soften your position to be agreeable — a debate with no disagreement left has nothing to teach.",
      maxVisits: 3,
    },
    {
      id: "moderate",
      label: "Moderate",
      prompt:
        "You moderate this debate.\n\nQuestion:\n{{frame}}\n\nThis round:\n{{speak}}\n\nYour notes from the previous round — empty in the first:\n{{moderate}}\n\nSay where the positions now agree, where they still differ, and what was conceded this round. Name the arguments still standing on each side.\n\nThen decide two things, separately: whether the debate is settled — the positions have converged, or the remaining disagreement is fully mapped and another round would not move it — and whether this round brought any new argument at all. A round that only restated the last one did not.",
      maxVisits: 3,
      fields: [
        {
          name: "settled",
          type: "boolean",
          options: [],
          description: "true when another round would change nothing",
        },
        {
          // The same third exit the evaluator loop has: positions that keep
          // talking without a new argument burn the budget and end as if the
          // rounds had run out.
          name: "progressed",
          type: "boolean",
          options: [],
          description: "false when this round only restated the last one",
        },
      ],
    },
    {
      id: "next-round",
      label: "Next round",
      kind: "note",
      prompt:
        "Back to the positions, one thread each, now with the last round and the moderator's notes in front of them.",
    },
    {
      id: "verdict",
      label: "Verdict",
      prompt:
        "The debate is over.\n\nQuestion:\n{{frame}}\n\nFinal round:\n{{speak}}\n\nModerator's notes:\n{{moderate}}\n\nWrite the outcome: what every position came to accept, what stays contested and why, and which reading the arguments support. Do not average the positions away — name the disagreement, take a side on it, and give the argument that decided it.",
    },
  ],
  edges: [
    { from: START_NODE, to: "frame" },
    { from: "frame", to: "speak", fanOutOver: "positions" },
    { from: "speak", to: "moderate" },
    // Three ways out, in the order they should be asked — the same discipline
    // as the evaluator loop: settled, stopped moving, out of rounds.
    {
      from: "moderate",
      to: "verdict",
      when: { source: "field", key: "moderate.settled", op: "equals", value: "true" },
      label: "settled",
    },
    {
      from: "moderate",
      to: "verdict",
      when: { source: "field", key: "moderate.progressed", op: "equals", value: "false" },
      label: "no longer moving",
    },
    {
      from: "moderate",
      to: "next-round",
      when: { source: "output", key: "", op: "visitsBelow", value: "3" },
      label: "rounds left",
    },
    { from: "moderate", to: "verdict", label: "rounds spent" },
    // The back edge is the fan-out. It reads the same list the first round
    // used, so the table stays the same across rounds.
    { from: "next-round", to: "speak", fanOutOver: "frame.positions" },
    { from: "verdict", to: END_NODE },
  ],
};

/**
 * Plan-and-execute. The plan decides how wide the work is, so the branch count
 * cannot be drawn in advance — this is what `fanOutOver` is for.
 */
const planAndExecute: Draft = {
  id: "plan-and-execute",
  name: "Plan and execute",
  description:
    "A planner breaks the task into steps, each step is carried out in its own thread, and a final pass bundles what came back. The number of steps is decided by the run, not by the graph.",
  example: "Bring every module under src/lib up to the current error-handling convention",
  maxSteps: 40,
  maxFanOut: 10,
  nodes: [
    {
      id: "plan",
      label: "Plan",
      prompt:
        "Break this task into steps that can be carried out independently of each other. Each step must stand on its own: someone doing step 4 will not see steps 1 to 3.\n\nTask:\n{{input}}",
      fields: [
        {
          name: "steps",
          type: "list",
          options: [],
          description: "one entry per independent step",
        },
      ],
    },
    {
      id: "step",
      label: "Carry out one step",
      prompt:
        "Carry out this one step. Stay inside it — anything else is someone else's step.\n\nOverall task:\n{{input}}\n\nYour step:\n{{item}}",
      maxVisits: 1,
    },
    {
      id: "bundle",
      label: "Bundle",
      prompt:
        "Bundle the results of the individual steps into one account. Say plainly which steps did not work out.\n\nTask:\n{{input}}\n\nPlan:\n{{plan}}\n\nResults:\n{{step}}",
    },
  ],
  edges: [
    { from: "__start__", to: "plan" },
    { from: "plan", to: "step", fanOutOver: "plan.steps" },
    { from: "step", to: "bundle" },
    { from: "bundle", to: "__end__" },
  ],
};

/**
 * Deferred choice: the branch is picked by the person, not by a classifier.
 * The distinction matters where the decision rests on something outside the
 * run — a deadline, a release, an agreement nobody wrote down.
 */
const deferredChoice: Draft = {
  id: "deferred-choice",
  name: "Deferred choice",
  description:
    "The graph prepares the ground, then a human picks the branch. For decisions that turn on something the run cannot see — a deadline, a promise made in a meeting, an appetite for risk.",
  example: "Decide how to deal with the duplicated pricing logic",
  maxSteps: 20,
  nodes: [
    {
      id: "survey",
      label: "Survey",
      prompt:
        "Lay out the situation and the realistic options. Do not recommend one — the decision is not yours.\n\nSituation:\n{{input}}",
    },
    {
      // An approval node has no declared fields: it does not run a worker, so
      // nothing parses JSON out of it — its result is the answer as typed.
      // The edges below therefore match on that text, anchored to the first
      // word, which is what keeps "not now" out of the NOW branch.
      id: "decide",
      label: "Your decision",
      kind: "human",
      prompt:
        "Which way do you want to go?\n\n{{survey}}\n\nStart your answer with ACT, DEFER or DROP; anything after that is yours to write.",
    },
    {
      id: "act",
      label: "Act on it",
      prompt: "Carry out the chosen option now.\n\nSituation:\n{{input}}\n\nSurvey:\n{{survey}}",
    },
    {
      id: "record",
      label: "Write it down",
      prompt:
        "Write this up so that whoever picks it up in three months has what they need — including why it was deferred.\n\nSituation:\n{{input}}\n\nSurvey:\n{{survey}}",
    },
  ],
  edges: [
    { from: "__start__", to: "survey" },
    { from: "survey", to: "decide" },
    { from: "decide", to: "act", when: { source: "output", key: "decide", op: "matches", value: "^\\s*ACT\\b" } },
    { from: "decide", to: "__end__", when: { source: "output", key: "decide", op: "matches", value: "^\\s*DROP\\b" } },
    // Fallback, and deliberately the harmless one: an answer nobody can parse
    // gets written down rather than acted on or silently dropped.
    { from: "decide", to: "record" },
    { from: "act", to: "__end__" },
    { from: "record", to: "__end__" },
  ],
};

/**
 * Milestone: a step is only allowed once an *earlier* node reached a given
 * state. The condition reads a field of a node further back, not of the one
 * the edge leaves — which is what separates this from an ordinary gate.
 */
const milestone: Draft = {
  id: "milestone",
  name: "Milestone",
  description:
    "A later step is only allowed once an earlier one confirmed the ground is solid. The edge reads a field from further back in the run, so the gate stays where the evidence was gathered.",
  example: "Roll out the new pricing rules once the data has been verified",
  maxSteps: 25,
  nodes: [
    {
      id: "verify",
      label: "Verify the ground",
      prompt:
        "Check whether the preconditions for this task actually hold. Look, do not assume.\n\nTask:\n{{input}}",
      fields: [
        {
          name: "ground",
          type: "enum",
          options: ["SOLID", "SHAKY"],
          description: "SOLID clears the later rollout, SHAKY does not",
        },
        { name: "reason", type: "string", options: [], description: "one sentence" },
      ],
    },
    {
      id: "prepare",
      label: "Prepare",
      prompt:
        "Prepare the change. Do not roll anything out — that is a separate step and may not happen.\n\nTask:\n{{input}}\n\nFindings:\n{{verify}}",
    },
    {
      id: "rollout",
      label: "Roll out",
      prompt:
        "Roll the prepared change out.\n\nTask:\n{{input}}\n\nPreparation:\n{{prepare}}",
    },
    {
      id: "hold",
      label: "Hold",
      prompt:
        "The ground was not solid. Write down what is prepared, what is missing, and what would have to be true to continue.\n\nFindings:\n{{verify}}\n\nPreparation:\n{{prepare}}",
    },
  ],
  edges: [
    { from: "__start__", to: "verify" },
    { from: "verify", to: "prepare" },
    // The milestone: this edge asks about `verify`, not about `prepare`.
    { from: "prepare", to: "rollout", when: { source: "field", key: "verify.ground", op: "equals", value: "SOLID" } },
    { from: "prepare", to: "hold" },
    { from: "rollout", to: "__end__" },
    { from: "hold", to: "__end__" },
  ],
};

/**
 * The inclusive or. Every area the triage names is worked on, and only those.
 * Note what this graph does *not* do: the branches end separately instead of
 * being merged. A branch that was not chosen never arrives, so a join waiting
 * for it would hang — see Roadmap #13.
 */
const multiChoice: Draft = {
  id: "multi-choice",
  name: "Multi-choice (inclusive or)",
  description:
    "Triage names the affected areas, and every area named is worked on in parallel — one, two or all three. Unlike a router this is not an either/or.",
  example: "The checkout fails silently when a voucher expires mid-session",
  maxSteps: 25,
  nodes: [
    {
      id: "triage",
      label: "Triage",
      prompt:
        "Which areas does this touch? Name every one that genuinely applies, and only those. Write them out as a list in your answer.\n\nRequest:\n{{input}}",
      routing: "every",
      fields: [
        {
          name: "areas",
          type: "string",
          options: [],
          description: "the areas concerned, named: backend, frontend, docs",
        },
      ],
    },
    {
      id: "backend",
      label: "Backend",
      prompt: "Work the backend side of this.\n\nRequest:\n{{input}}\n\nTriage:\n{{triage}}",
    },
    {
      id: "frontend",
      label: "Frontend",
      prompt: "Work the frontend side of this.\n\nRequest:\n{{input}}\n\nTriage:\n{{triage}}",
    },
    {
      id: "docs",
      label: "Docs",
      prompt: "Work the documentation side of this.\n\nRequest:\n{{input}}\n\nTriage:\n{{triage}}",
    },
  ],
  edges: [
    { from: "__start__", to: "triage" },
    { from: "triage", to: "backend", when: { source: "field", key: "triage.areas", op: "contains", value: "backend" } },
    { from: "triage", to: "frontend", when: { source: "field", key: "triage.areas", op: "contains", value: "frontend" } },
    { from: "triage", to: "docs", when: { source: "field", key: "triage.areas", op: "contains", value: "docs" } },
    { from: "backend", to: "__end__" },
    { from: "frontend", to: "__end__" },
    { from: "docs", to: "__end__" },
  ],
};

/* ── the canon, continued ────────────────────────────────────────────────
 *
 * The patterns below close the gap against the agentic-pattern catalogue:
 * prompt chaining, ReAct, supervisor, hierarchy and the state machine from the
 * topology table, plus the three reliability patterns that are a graph shape
 * rather than a node setting (guardrail, circuit breaker, saga).
 *
 * Swarm/handoff and blackboard are deliberately absent: both need an agent to
 * choose where control goes next, and routing here always belongs to the edge.
 * They are listed under Roadmap #15, not offered as templates that could not
 * work.
 */

/** The simplest shape there is, and the one most work actually needs. */
const promptChaining: Draft = {
  id: "prompt-chaining",
  name: "Prompt chaining",
  description:
    "One step feeds the next, with a gate in between that can stop the chain. The plainest shape in the catalogue — and the one to reach for whenever the sequence is genuinely known in advance.",
  example: "Turn the meeting notes into a decision record",
  maxSteps: 16,
  nodes: [
    {
      id: "extract",
      label: "Extract",
      prompt:
        "Pull out the material the task below rests on. Gather, do not judge.\n\nTask:\n{{input}}",
    },
    {
      id: "gate",
      label: "Check the material",
      prompt:
        "Is this enough to work from? Say what is missing rather than working around it.\n\nTask:\n{{input}}\n\nMaterial:\n{{extract}}",
      fields: [
        {
          name: "enough",
          type: "enum",
          options: ["ENOUGH", "THIN"],
          description: "THIN stops the chain rather than guessing onwards",
        },
        { name: "reason", type: "string", options: [], description: "one sentence" },
      ],
    },
    {
      id: "shape",
      label: "Shape",
      prompt:
        "Bring the material into the form the task asks for.\n\nTask:\n{{input}}\n\nMaterial:\n{{extract}}",
    },
    {
      id: "polish",
      label: "Polish",
      prompt:
        "Tighten this until every line earns its place. Change nothing about the substance.\n\n{{shape}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "extract" },
    { from: "extract", to: "gate" },
    {
      from: "gate",
      to: END_NODE,
      when: { source: "field", key: "gate.enough", op: "equals", value: "THIN" },
      label: "THIN",
    },
    { from: "gate", to: "shape", label: "ENOUGH" },
    { from: "shape", to: "polish" },
    { from: "polish", to: END_NODE },
  ],
};

/**
 * ReAct as a graph rather than inside one worker. The point of drawing it out
 * is that each thought and each action becomes a thread you can read
 * afterwards — inside a single agent the same loop happens invisibly.
 */
const reactLoop: Draft = {
  id: "react-loop",
  name: "ReAct (reason → act → observe)",
  description:
    "Think, do one thing, look at what came back, repeat. Drawn as a graph so that every round is a thread you can read — inside a single agent the same loop leaves no trace.",
  example: "Find out why the nightly build got two minutes slower",
  maxSteps: 40,
  nodes: [
    {
      id: "think",
      label: "Reason",
      prompt:
        "Decide the single next step that would tell you most about this task. One step, and say what you expect to learn from it.\n\nTask:\n{{input}}\n\nWhat you have done and seen so far:\n{{observe}}",
      maxVisits: 6,
      fields: [
        {
          name: "state",
          type: "enum",
          options: ["ACT", "ANSWER", "STUCK"],
          description: "ACT takes another step, ANSWER has it, STUCK gives up openly",
        },
      ],
    },
    {
      id: "act",
      label: "Act",
      prompt:
        "Carry out exactly the step named below — read, run, measure. Nothing beyond it, and no conclusions.\n\nStep:\n{{think}}",
      maxVisits: 6,
    },
    {
      id: "observe",
      label: "Observe",
      prompt:
        "Write down what actually came back, separately from what it means. Keep it short enough that the next round can read all of it.\n\nSo far:\n{{observe}}\n\nLast step:\n{{think}}\n\nResult:\n{{act}}",
      maxVisits: 6,
    },
    {
      id: "answer",
      label: "Answer",
      prompt:
        "Answer the task from what you found. Name what is still uncertain.\n\nTask:\n{{input}}\n\nWhat you saw:\n{{observe}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "think" },
    {
      from: "think",
      to: "answer",
      when: { source: "field", key: "think.state", op: "equals", value: "ANSWER" },
      label: "ANSWER",
    },
    {
      from: "think",
      to: END_NODE,
      when: { source: "field", key: "think.state", op: "equals", value: "STUCK" },
      label: "STUCK",
    },
    { from: "think", to: "act", label: "ACT" },
    { from: "act", to: "observe" },
    { from: "observe", to: "think" },
    { from: "answer", to: END_NODE },
  ],
};

/**
 * A supervisor delegates and gets control back — the star shape. What makes it
 * a supervisor rather than a router is the return edge: the lead decides again
 * after each specialist, with what came back in hand.
 */
const supervisor: Draft = {
  id: "supervisor",
  name: "Supervisor (delegate and return)",
  description:
    "A lead hands work to a named specialist, gets control back, and decides again — with the result in hand. Unlike routing this is a cycle: several specialists can run one after another.",
  example: "Get the release notes ready for the 4.2 release",
  maxSteps: 40,
  nodes: [
    {
      id: "lead",
      label: "Lead",
      prompt:
        "You hold this task. Decide who does the next piece, and say what exactly you are asking of them.\n\nPick DONE once nothing is left that a specialist should do — not once everything imaginable is done.\n\nTask:\n{{input}}\n\nWhat has come back so far:\n{{code}}\n{{docs}}\n{{checks}}",
      maxVisits: 6,
      fields: [
        {
          name: "next",
          type: "enum",
          options: ["CODE", "DOCS", "CHECKS", "DONE"],
          description: "who takes the next piece, or DONE",
        },
        { name: "task", type: "string", options: [], description: "what you ask of them" },
      ],
    },
    {
      id: "code",
      label: "Code specialist",
      prompt: "Do the code part the lead asked for, nothing else.\n\nAsked of you:\n{{lead}}",
      maxVisits: 4,
    },
    {
      id: "docs",
      label: "Docs specialist",
      prompt: "Do the documentation part the lead asked for, nothing else.\n\nAsked of you:\n{{lead}}",
      maxVisits: 4,
    },
    {
      id: "checks",
      label: "Checks specialist",
      prompt: "Do the checking the lead asked for, nothing else. Report, do not repair.\n\nAsked of you:\n{{lead}}",
      maxVisits: 4,
    },
    {
      id: "wrap",
      label: "Wrap up",
      prompt:
        "Pull together what the specialists did into one account.\n\nTask:\n{{input}}\n\nCode:\n{{code}}\n\nDocs:\n{{docs}}\n\nChecks:\n{{checks}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "lead" },
    {
      from: "lead",
      to: "code",
      when: { source: "field", key: "lead.next", op: "equals", value: "CODE" },
      label: "CODE",
    },
    {
      from: "lead",
      to: "docs",
      when: { source: "field", key: "lead.next", op: "equals", value: "DOCS" },
      label: "DOCS",
    },
    {
      from: "lead",
      to: "checks",
      when: { source: "field", key: "lead.next", op: "equals", value: "CHECKS" },
      label: "CHECKS",
    },
    { from: "lead", to: "wrap", label: "DONE" },
    // The return edges are what make this a supervisor and not a router.
    { from: "code", to: "lead" },
    { from: "docs", to: "lead" },
    { from: "checks", to: "lead" },
    { from: "wrap", to: END_NODE },
  ],
};

/**
 * Hierarchy: a node that is itself a graph. Distinct from the supervisor —
 * there the lead names a *worker*, here a whole flow is reused as one step.
 */
const hierarchical: Draft = {
  id: "hierarchical",
  name: "Hierarchy (a node that is a graph)",
  description:
    "One step is a whole flow of its own, embedded as a subgraph. Its nodes run in this run and share the state, so a later step can read a result from inside it.",
  example: "Draft the migration guide, then check it against the code",
  maxSteps: 40,
  nodes: [
    {
      id: "brief",
      label: "Brief",
      prompt:
        "State what has to be produced, in two or three sentences. No solution.\n\nTask:\n{{input}}",
    },
    {
      // The embedded flow writes under *its* node ids, not under this one —
      // which is why the node below reads {{revise}} and not {{inner}}.
      id: "inner",
      label: "Produce it",
      kind: "subgraph",
      graphId: "evaluator-optimizer",
      prompt: "",
    },
    {
      id: "verify",
      label: "Verify against reality",
      prompt:
        "Check the result below against the code and against the brief. Name what does not hold up.\n\nBrief:\n{{brief}}\n\nResult:\n{{revise}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "brief" },
    { from: "brief", to: "inner" },
    { from: "inner", to: "verify" },
    { from: "verify", to: END_NODE },
  ],
};

/**
 * The graph as an explicit state machine: one field holds the state, the edges
 * are the transitions. Every other cycle here is one too — this one says so,
 * which is the difference between a flow you can reason about and one you
 * rediscover by reading edges.
 */
const stateMachine: Draft = {
  id: "state-machine",
  name: "State machine",
  description:
    "One field holds the state, the edges are the transitions. For approval-shaped work where \"where are we?\" has a name and not just a position in the graph.",
  example: "Take a customer complaint from intake to resolution",
  maxSteps: 40,
  nodes: [
    {
      id: "intake",
      label: "Intake",
      prompt:
        "Take the matter in and put it in a state.\n\nMatter:\n{{input}}",
      fields: [
        {
          name: "state",
          type: "enum",
          options: ["NEEDS_INFO", "READY", "REJECTED"],
          description: "where this stands after intake",
        },
      ],
    },
    {
      id: "gather",
      label: "Gather what is missing",
      kind: "human",
      maxVisits: 3,
      prompt: "What is missing was named above. Add it, and the matter goes back to intake.",
    },
    {
      id: "work",
      label: "Work it",
      prompt: "Deal with the matter now that it is ready.\n\nMatter:\n{{input}}\n\nIntake:\n{{intake}}",
      fields: [
        {
          name: "state",
          type: "enum",
          options: ["RESOLVED", "ESCALATED"],
          description: "where this stands after the work",
        },
      ],
    },
    {
      id: "escalate",
      label: "Escalate",
      kind: "human",
      prompt: "This could not be resolved at this level. Decide how to carry on.",
    },
    {
      id: "close",
      label: "Close",
      prompt: "Close the matter with a record of what happened and why.\n\nMatter:\n{{input}}\n\nWork:\n{{work}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "intake" },
    {
      from: "intake",
      to: "gather",
      when: { source: "field", key: "intake.state", op: "equals", value: "NEEDS_INFO" },
      label: "NEEDS_INFO",
    },
    {
      from: "intake",
      to: END_NODE,
      when: { source: "field", key: "intake.state", op: "equals", value: "REJECTED" },
      label: "REJECTED",
    },
    { from: "intake", to: "work", label: "READY" },
    { from: "gather", to: "intake" },
    {
      from: "work",
      to: "escalate",
      when: { source: "field", key: "work.state", op: "equals", value: "ESCALATED" },
      label: "ESCALATED",
    },
    { from: "work", to: "close", label: "RESOLVED" },
    { from: "escalate", to: "close" },
    { from: "close", to: END_NODE },
  ],
};

/* ── reliability, where it is a shape and not a setting ──────────────────
 *
 * Retry belongs on the node (`maxAttempts`), durability to the checkpointer,
 * idempotence to whoever writes a node's prompt. The three below are different:
 * they are graphs, and drawing them is the only way to have them.
 */

/** Check before the step that cannot be taken back. */
const guardrail: Draft = {
  id: "guardrail",
  name: "Guardrail before the irreversible step",
  description:
    "A check stands between the work and the step that cannot be undone, and it may refuse. The point is the order: the guard runs before anything leaves the building, not after.",
  example: "Apply the data migration to the production database",
  maxSteps: 24,
  nodes: [
    {
      id: "prepare",
      label: "Prepare",
      prompt:
        "Prepare the change completely, but apply nothing. Say exactly what would happen when it is applied.\n\nTask:\n{{input}}",
      maxVisits: 3,
    },
    {
      id: "guard",
      label: "Guard",
      prompt:
        "You are the last check before this takes effect, and you may refuse. Look for what cannot be undone: deletions, migrations, anything that leaves this machine.\n\nDo not weigh how much work went into it. A refusal costs one round; letting it through costs whatever it does.\n\nPrepared:\n{{prepare}}",
      maxVisits: 3,
      fields: [
        {
          name: "verdict",
          type: "enum",
          options: ["SAFE", "FIX_FIRST", "REFUSE"],
          description: "SAFE lets it through, FIX_FIRST goes back, REFUSE ends it",
        },
        { name: "reason", type: "string", options: [], description: "one sentence" },
      ],
    },
    {
      id: "apply",
      label: "Apply",
      prompt: "Apply the prepared change now.\n\nPrepared:\n{{prepare}}\n\nGuard:\n{{guard}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "prepare" },
    { from: "prepare", to: "guard" },
    {
      from: "guard",
      to: "prepare",
      when: { source: "field", key: "guard.verdict", op: "equals", value: "FIX_FIRST" },
      label: "FIX_FIRST",
    },
    {
      from: "guard",
      to: END_NODE,
      when: { source: "field", key: "guard.verdict", op: "equals", value: "REFUSE" },
      label: "REFUSE",
    },
    { from: "guard", to: "apply", label: "SAFE" },
    { from: "apply", to: END_NODE },
  ],
};

/**
 * Circuit breaker: retrying is fine until it obviously is not, and then a
 * person decides. The `visitsBelow` edge is the breaker — without it the loop
 * would keep trying until the budget ran out and then simply stop, which looks
 * the same from outside as success.
 */
const circuitBreaker: Draft = {
  id: "circuit-breaker",
  name: "Circuit breaker (retry, then a person)",
  description:
    "Try, check, try again — but after a fixed number of rounds the loop opens and hands over to a person instead of quietly exhausting its budget.",
  example: "Get the flaky integration test green again",
  maxSteps: 40,
  nodes: [
    {
      id: "attempt",
      label: "Attempt",
      prompt:
        "Work on this task. If there is an earlier failure below, treat it as the thing to fix.\n\nTask:\n{{input}}\n\nEarlier failure:\n{{check}}",
      maxVisits: 5,
    },
    {
      id: "check",
      label: "Check",
      prompt:
        "Check whether it worked. Report the outcome, do not repair it.\n\nAttempt:\n{{attempt}}",
      maxVisits: 5,
      fields: [
        {
          name: "status",
          type: "enum",
          options: ["OK", "FAILED"],
          description: "OK only if it genuinely worked",
        },
        { name: "detail", type: "string", options: [], description: "on FAILED: what failed" },
      ],
    },
    {
      id: "escalate",
      label: "Hand over to a person",
      kind: "human",
      prompt:
        "Three attempts did not get there. What came back is above — how do you want to carry on?",
    },
    {
      id: "report",
      label: "Report",
      prompt:
        "Say what was attempted, what worked, and what is left.\n\nTask:\n{{input}}\n\nLast attempt:\n{{attempt}}\n\nCheck:\n{{check}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "attempt" },
    { from: "attempt", to: "check" },
    { from: "check", to: "report", when: { source: "field", key: "check.status", op: "equals", value: "OK" }, label: "OK" },
    // The breaker itself: while there are rounds left, go back; otherwise a
    // person takes over. Order matters — the conditional edge is tried first.
    {
      from: "check",
      to: "attempt",
      when: { source: "output", key: "attempt", op: "visitsBelow", value: "3" },
      label: "rounds left",
    },
    { from: "check", to: "escalate", label: "breaker open" },
    { from: "escalate", to: "report" },
    { from: "report", to: END_NODE },
  ],
};

/**
 * Saga: every step that changes something has a step that undoes it. Where a
 * transaction cannot span the work, the compensation is the transaction.
 */
const saga: Draft = {
  id: "saga-compensation",
  name: "Saga (undo what was done)",
  description:
    "A change is applied, then verified — and if the verification fails, a compensating step puts things back. For work that spans several systems, where no single transaction covers it.",
  example: "Roll out the new pricing rules across service and cache",
  maxSteps: 30,
  nodes: [
    {
      id: "plan",
      label: "Plan with an undo",
      prompt:
        "Plan this change, and for every step say how it would be undone. A step whose undo you cannot name does not go in the plan.\n\nTask:\n{{input}}",
    },
    {
      id: "apply",
      label: "Apply",
      prompt: "Carry out the plan, in order.\n\nPlan:\n{{plan}}",
    },
    {
      id: "verify",
      label: "Verify",
      prompt:
        "Check whether the change really took effect everywhere the plan named. Report, do not repair.\n\nPlan:\n{{plan}}\n\nApplied:\n{{apply}}",
      fields: [
        {
          name: "status",
          type: "enum",
          options: ["HOLDS", "BROKEN"],
          description: "BROKEN triggers the compensation",
        },
        { name: "detail", type: "string", options: [], description: "what is off" },
      ],
    },
    {
      id: "compensate",
      label: "Undo",
      prompt:
        "Undo what was applied, using the undo steps from the plan, in reverse order. Leave the system as it was — do not try to fix it forward.\n\nPlan:\n{{plan}}\n\nApplied:\n{{apply}}\n\nWhat is off:\n{{verify}}",
    },
    {
      id: "report",
      label: "Report",
      prompt:
        "Say what happened: applied and holding, or applied and undone. If it was undone, say what state things are in now.\n\nApplied:\n{{apply}}\n\nVerification:\n{{verify}}\n\nUndo:\n{{compensate}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "plan" },
    { from: "plan", to: "apply" },
    { from: "apply", to: "verify" },
    {
      from: "verify",
      to: "compensate",
      when: { source: "field", key: "verify.status", op: "equals", value: "BROKEN" },
      label: "BROKEN",
    },
    { from: "verify", to: "report", label: "HOLDS" },
    { from: "compensate", to: "report" },
    { from: "report", to: END_NODE },
  ],
};

/**
 * Behaviour tree, the fallback branch: try, and if that does not work, try the
 * other thing.
 *
 * The only template built on `onError: route`, and it is the whole point of
 * it. Everywhere else in this library a step that gives up ends the run, which
 * is right when there is no sensible way onward. Here there is one: the second
 * route is not a retry of the first — a retry would do the same thing again —
 * but a different approach, chosen because the first one failed and told us
 * why. `{{primary.error}}` is how the fallback learns what it is standing in
 * for.
 *
 * The last node deserves its place: when both routes are out, somebody has to
 * write down what was tried. A run that simply stops leaves that knowledge in
 * two dead threads.
 */
const fallbackChain: Draft = {
  id: "fallback-chain",
  name: "Fallback (try, then try otherwise)",
  description:
    "The direct route runs first. If it gives up, a second route takes over knowing why the first one failed — and if that gives up too, the run ends with a written account rather than an error.",
  example: "Get the flaky end-to-end suite running in CI again",
  maxSteps: 24,
  nodes: [
    {
      id: "primary",
      label: "Direct route",
      prompt:
        "Solve this task the direct way — the obvious approach, no detours.\n\nTask:\n{{input}}",
      maxAttempts: 2,
      onError: "route",
    },
    {
      id: "fallback",
      label: "Other route",
      prompt:
        "The direct approach was tried and gave up. Solve the task a different way — do not repeat what already failed.\n\nTask:\n{{input}}\n\nWhy the direct approach gave up:\n{{primary.error}}",
      maxAttempts: 2,
      onError: "route",
    },
    {
      id: "give_up",
      label: "Give up, in writing",
      prompt:
        "Both routes are out. Write down what was tried, what each of them ran into, and what a person would have to decide or provide for this to go on. Do not attempt the task again.\n\nTask:\n{{input}}\n\nDirect route gave up:\n{{primary.error}}\n\nOther route gave up:\n{{fallback.error}}",
    },
    {
      id: "report",
      label: "Report",
      prompt:
        "Say what worked and by which route, in a few sentences.\n\nDirect route:\n{{primary}}\n\nOther route:\n{{fallback}}",
    },
  ],
  edges: [
    { from: START_NODE, to: "primary" },
    // Order is the priority list: the failure edge is tried first, and the
    // unconditional one below it is the success case. Reversed, the fallback
    // would be unreachable — the same edge-order trap the router has.
    {
      from: "primary",
      to: "fallback",
      when: { source: "output", key: "", op: "failed", value: "" },
      label: "gave up",
    },
    { from: "primary", to: "report" },
    {
      from: "fallback",
      to: "give_up",
      when: { source: "output", key: "", op: "failed", value: "" },
      label: "gave up too",
    },
    { from: "fallback", to: "report" },
    { from: "give_up", to: END_NODE },
    { from: "report", to: END_NODE },
  ],
};

/**
 * Swarm: every specialist may name the next one.
 *
 * The one template where routing does not belong to the author. Everywhere
 * else an edge decides where the run goes; here the edge only says "read
 * `next`", and the worker that just finished writes it. That is the whole
 * difference between this and `supervisor`, where one lead holds the decision
 * and control always comes back to it.
 *
 * Built in the enum form on purpose. A `next` of free text would be the more
 * literal swarm, but then the canvas could not draw a single one of these
 * handoffs and the validator could not tell an unreachable node from a node
 * somebody hands off to. Declaring the possible successors costs the author
 * three lines and keeps both.
 *
 * Every specialist also gets `status`, because "who is next" and "are we done"
 * are two questions and one enum answering both would need an option that is
 * not a node.
 */
const swarm: Draft = {
  id: "swarm",
  name: "Swarm (each hands on)",
  description:
    "Specialists pass the task among themselves: whoever is working names who should take it next, until one of them says it is finished. No lead node in the middle.",
  example: "Write the release notes for the current milestone",
  maxSteps: 30,
  nodes: [
    {
      id: "research",
      label: "Research",
      prompt:
        "You are the research specialist in a small team. Gather what is needed and write down what you found.\n\nWhen your part is done, hand the task on: `next` is \"write\" for drafting or \"review\" for checking. If the whole task is finished, set `status` to DONE.\n\nTask:\n{{input}}\n\nWhat the team has so far:\n{{write}}\n{{review}}",
      maxVisits: 3,
      fields: [
        {
          name: "status",
          type: "enum",
          options: ["HANDOFF", "DONE"],
          description: "HANDOFF passes it on, DONE ends the run",
        },
        {
          name: "next",
          type: "enum",
          options: ["write", "review"],
          description: "who takes it next; only read when status is HANDOFF",
        },
      ],
    },
    {
      id: "write",
      label: "Write",
      prompt:
        "You are the writing specialist in a small team. Draft the text the task asks for.\n\nWhen your part is done, hand the task on: `next` is \"research\" if something is missing or \"review\" if it is ready to be checked. If the whole task is finished, set `status` to DONE.\n\nTask:\n{{input}}\n\nWhat the team has so far:\n{{research}}\n{{review}}",
      maxVisits: 3,
      fields: [
        {
          name: "status",
          type: "enum",
          options: ["HANDOFF", "DONE"],
          description: "HANDOFF passes it on, DONE ends the run",
        },
        {
          name: "next",
          type: "enum",
          options: ["research", "review"],
          description: "who takes it next; only read when status is HANDOFF",
        },
      ],
    },
    {
      id: "review",
      label: "Review",
      prompt:
        "You are the reviewing specialist in a small team. Check what is there against the task and say what does not hold.\n\nIf something needs doing, hand it on: `next` is \"research\" for missing facts or \"write\" for the text itself. If it holds, set `status` to DONE.\n\nTask:\n{{input}}\n\nWhat the team has so far:\n{{research}}\n{{write}}",
      maxVisits: 3,
      fields: [
        {
          name: "status",
          type: "enum",
          options: ["HANDOFF", "DONE"],
          description: "HANDOFF passes it back, DONE ends the run",
        },
        {
          name: "next",
          type: "enum",
          options: ["research", "write"],
          description: "who takes it next; only read when status is HANDOFF",
        },
      ],
    },
    {
      id: "finish",
      label: "Hand over",
      prompt:
        "The team is done. Put together what it produced, in the form the task asked for.\n\nTask:\n{{input}}\n\nResearch:\n{{research}}\n\nDraft:\n{{write}}\n\nReview:\n{{review}}",
    },
  ],
  // Two edges per specialist, and the order is the priority: hand on if it
  // said so, otherwise finish. The handoff edge's own target is that same
  // fallback — a specialist that asks for a successor nobody knows ends up
  // handing over rather than derailing the run, and the log says it happened.
  edges: [
    { from: START_NODE, to: "research" },
    {
      from: "research",
      to: "finish",
      when: { source: "field", key: "research.status", op: "equals", value: "HANDOFF" },
      handoffFrom: "research.next",
      label: "HANDOFF",
    },
    { from: "research", to: "finish", label: "DONE" },
    {
      from: "write",
      to: "finish",
      when: { source: "field", key: "write.status", op: "equals", value: "HANDOFF" },
      handoffFrom: "write.next",
      label: "HANDOFF",
    },
    { from: "write", to: "finish", label: "DONE" },
    {
      from: "review",
      to: "finish",
      when: { source: "field", key: "review.status", op: "equals", value: "HANDOFF" },
      handoffFrom: "review.next",
      label: "HANDOFF",
    },
    { from: "review", to: "finish", label: "DONE" },
    { from: "finish", to: END_NODE },
  ],
};

/**
 * The library, in the order it is offered.
 *
 * Not alphabetical and not chronological: both scatter related shapes and make
 * the list something you scan rather than read. The patterns run from the
 * simplest control flow to the most composed — one branch, then a branch that
 * rejoins, then parallelism, then cycles — so that reading down the list is a
 * tour of what the engine can express. The work flows run in the order the
 * work itself happens: before there is a task, while writing the concept,
 * while building, and finally the arc that covers both.
 */
export const TEMPLATES: Graph[] = [
  // Patterns — one step after another
  promptChaining,
  // Patterns — one branch chosen
  router,
  simpleMerge,
  multiChoice,
  deferredChoice,
  // Patterns — several branches at once
  fanOut,
  ensembleVote,
  fanOutDynamic,
  planAndExecute,
  debate,
  // Patterns — state and cycles
  milestone,
  stateMachine,
  reflexion,
  reactLoop,
  harnessArc,
  // Patterns — one flow delegating to another
  supervisor,
  hierarchical,
  swarm,
  // Patterns — reliability, where it is a shape
  guardrail,
  circuitBreaker,
  saga,
  fallbackChain,

  // Work — before there is a task
  ideaToConcept,
  conceptWaves,
  // Work — writing the concept
  conceptFeature,
  conceptArchitecture,
  conceptDomain,
  // Work — building
  devTdd,
  devBugfix,
  devRefactor,
  // Work — both ends
  projectEndToEnd,
].map(build);



/**
 * What a template is for. The library mixes two quite different things, and a
 * flat list hides the difference: a control-flow pattern is a shape you build
 * on, while the work templates are this repository's own routines and carry
 * assumptions about how we work here. Someone looking for "how do I run
 * three takes and reconcile them" and someone looking for "the usual bugfix
 * arc" are not browsing the same list.
 *
 * Deliberately by character, not by age: `harness-arc`, `router` and the two
 * fan-outs are among the oldest templates and belong with the patterns.
 */
export const TEMPLATE_GROUPS = {
  pattern: "Patterns — established flows",
  work: "Work — flows for this repo",
} as const;
export type TemplateGroup = keyof typeof TEMPLATE_GROUPS;

const GROUP_OF: Record<string, TemplateGroup> = {
  // Kept in the same order as TEMPLATES, so the two read together.
  "prompt-chaining": "pattern",
  routing: "pattern",
  "simple-merge": "pattern",
  "multi-choice": "pattern",
  "deferred-choice": "pattern",
  "parallel-sectioning": "pattern",
  "ensemble-vote": "pattern",
  "map-reduce": "pattern",
  "plan-and-execute": "pattern",
  debate: "pattern",
  milestone: "pattern",
  "state-machine": "pattern",
  "evaluator-optimizer": "pattern",
  "react-loop": "pattern",
  "harness-arc": "pattern",
  supervisor: "pattern",
  hierarchical: "pattern",
  swarm: "pattern",
  guardrail: "pattern",
  "circuit-breaker": "pattern",
  "saga-compensation": "pattern",
  "fallback-chain": "pattern",
  "idea-to-concept": "work",
  "concept-waves": "work",
  "concept-feature": "work",
  "concept-architecture": "work",
  "concept-domain": "work",
  "dev-tdd": "work",
  "dev-bugfix": "work",
  "dev-refactor": "work",
  "project-end-to-end": "work",
};

/**
 * A template's group, or `null` for an id the library does not ship — which is
 * how a saved graph of somebody's own is told apart from a template. A test
 * holds the assignment complete, so `null` really does mean "not a template".
 */
export function templateGroup(id: string): TemplateGroup | null {
  return GROUP_OF[id] ?? null;
}

/**
 * The finer shelf inside a group.
 *
 * The order of `TEMPLATES` is already a curriculum — one branch, then a branch
 * that rejoins, then parallelism, then cycles — but until now that reading was
 * only in the comments between the entries, where nobody browsing the library
 * ever saw it. Two headings for twenty-nine graphs say "these are patterns",
 * which the reader already knew; they do not say why `state-machine` sits next
 * to `milestone`. These labels carry the same split as data, so the listing can
 * show it.
 *
 * Kept separate from `TEMPLATE_GROUPS` rather than replacing it: the coarse
 * pair is what the CLI listing and the pattern-coverage tests speak in, and
 * ten headings in a terminal column would bury the two-way distinction that
 * listing exists to make.
 */
export const TEMPLATE_SECTIONS = {
  "pattern-sequence": "Patterns — one step after another",
  "pattern-branch": "Patterns — one branch chosen",
  "pattern-parallel": "Patterns — several branches at once",
  "pattern-state": "Patterns — state and cycles",
  "pattern-delegating": "Patterns — one flow delegating to another",
  "pattern-reliability": "Patterns — reliability, where it is a shape",
  "work-before": "Work — before there is a task",
  "work-concept": "Work — writing the concept",
  "work-building": "Work — building",
  "work-both-ends": "Work — both ends",
} as const;
export type TemplateSection = keyof typeof TEMPLATE_SECTIONS;

const SECTION_OF: Record<string, TemplateSection> = {
  // Kept in the same order as TEMPLATES, so the two read together.
  "prompt-chaining": "pattern-sequence",
  routing: "pattern-branch",
  "simple-merge": "pattern-branch",
  "multi-choice": "pattern-branch",
  "deferred-choice": "pattern-branch",
  "parallel-sectioning": "pattern-parallel",
  "ensemble-vote": "pattern-parallel",
  "map-reduce": "pattern-parallel",
  "plan-and-execute": "pattern-parallel",
  debate: "pattern-parallel",
  milestone: "pattern-state",
  "state-machine": "pattern-state",
  "evaluator-optimizer": "pattern-state",
  "react-loop": "pattern-state",
  "harness-arc": "pattern-state",
  supervisor: "pattern-delegating",
  hierarchical: "pattern-delegating",
  swarm: "pattern-delegating",
  guardrail: "pattern-reliability",
  "circuit-breaker": "pattern-reliability",
  "saga-compensation": "pattern-reliability",
  "fallback-chain": "pattern-reliability",
  "idea-to-concept": "work-before",
  "concept-waves": "work-before",
  "concept-feature": "work-concept",
  "concept-architecture": "work-concept",
  "concept-domain": "work-concept",
  "dev-tdd": "work-building",
  "dev-bugfix": "work-building",
  "dev-refactor": "work-building",
  "project-end-to-end": "work-both-ends",
};

/** A template's finer shelf, or `null` for an id the library does not ship. */
export function templateSection(id: string): TemplateSection | null {
  return SECTION_OF[id] ?? null;
}

/** The group a finer section belongs to — the prefix is the whole rule. */
export function sectionGroup(section: TemplateSection): TemplateGroup {
  return section.startsWith("pattern") ? "pattern" : "work";
}

/** How fine the template headings are — see `groupedLibrary`. */
export type LibraryDetail = "group" | "section";

/**
 * One heading with its graphs. `group` is `null` for the reader's own graphs,
 * which is what tells "saved by somebody" apart from "shipped" downstream
 * without asking about every id again.
 */
export interface LibrarySection {
  key: string;
  label: string;
  group: TemplateGroup | null;
  graphs: Graph[];
}

/**
 * Any list of graphs, split into the sections it should be shown in. One
 * implementation for the CLI listing, the run picker and both editor dropdowns
 * — four places that would otherwise each decide for themselves what "own
 * graph" means and drift apart.
 *
 * Own graphs lead: somebody built them on purpose, and that is what a reader
 * scanning the list is most often after. Empty sections are dropped, so a
 * library without saved graphs shows no empty heading.
 *
 * `detail` picks how fine the template headings are, and the default is the
 * coarse pair on purpose: a terminal column and a small dropdown want two
 * headings, while a picker with room for a line of prose per graph can carry
 * the ten that show what the order of the catalogue is trying to teach.
 */
/**
 * The catalogue pattern each template stands for.
 *
 * Exists because the name alone is not what people look for. Somebody after
 * "orchestrator–worker" needs `map-reduce`, somebody after "voting" needs
 * `ensemble-vote`, and neither word appears in either name. This is the
 * vocabulary of the pattern catalogue, mapped onto the library — and it is one
 * table, read by the listing, the search and the test that holds the coverage
 * complete. A second copy would drift, and then "do we have ReAct?" would have
 * two answers.
 */
const PATTERN_OF: Record<string, string> = {
  "prompt-chaining": "Prompt chaining",
  routing: "Routing",
  "simple-merge": "Routing",
  "multi-choice": "Routing",
  "deferred-choice": "State machine",
  "parallel-sectioning": "Parallelization — sectioning",
  "ensemble-vote": "Parallelization — voting",
  "map-reduce": "Orchestrator–worker",
  "plan-and-execute": "Orchestrator–worker",
  debate: "Debate / mesh",
  milestone: "State machine",
  "state-machine": "State machine",
  "evaluator-optimizer": "Evaluator–optimizer",
  "react-loop": "ReAct",
  "harness-arc": "Evaluator–optimizer",
  supervisor: "Supervisor",
  hierarchical: "Hierarchical / subgraph",
  swarm: "Swarm / handoff",
  guardrail: "Guardrail",
  "circuit-breaker": "Circuit breaker",
  "saga-compensation": "Saga / compensation",
  "fallback-chain": "Behaviour tree / fallback",
};

/** The catalogue pattern a template stands for, or `null` for a work flow. */
export function templatePattern(id: string): string | null {
  return PATTERN_OF[id] ?? null;
}

/**
 * Templates matching a search term, across everything a person might type: id,
 * name, description, example and the catalogue pattern. Case-insensitive, and
 * an empty term matches everything — a search that hides the library until you
 * type is worse than no search.
 */
export function searchGraphs(graphs: Graph[], term: string): Graph[] {
  const needle = term.trim().toLowerCase();
  if (needle === "") return graphs;
  return graphs.filter((graph) =>
    [graph.id, graph.name, graph.description, graph.example, templatePattern(graph.id) ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

export function groupedLibrary(
  graphs: Graph[],
  detail: LibraryDetail = "group",
): LibrarySection[] {
  const own: LibrarySection = {
    key: "own",
    label: "Your graphs",
    group: null,
    graphs: graphs.filter((graph) => templateGroup(graph.id) === null),
  };
  const shelves: LibrarySection[] =
    detail === "section"
      ? (Object.keys(TEMPLATE_SECTIONS) as TemplateSection[]).map((section) => ({
          key: section,
          label: TEMPLATE_SECTIONS[section],
          group: sectionGroup(section),
          graphs: graphs.filter((graph) => templateSection(graph.id) === section),
        }))
      : (Object.keys(TEMPLATE_GROUPS) as TemplateGroup[]).map((group) => ({
          key: group,
          label: TEMPLATE_GROUPS[group],
          group,
          graphs: graphs.filter((graph) => templateGroup(graph.id) === group),
        }));
  return [own, ...shelves].filter((section) => section.graphs.length > 0);
}


/**
 * Ids the library used to ship under, mapped to what they are called now.
 *
 * Renaming a template does not break runs — `runs.graph_json` keeps its own
 * snapshot — and it does not break clones, which carry their own id. What it
 * does break is a *reference*: a subgraph node stores `graphId` and resolves it
 * at run time, so a graph of somebody's own pointing at `gedanke-zu-konzept`
 * would have found nothing. Kept rather than dropped, because the cost is one
 * lookup and the failure it prevents is silent.
 */
export const RENAMED_TEMPLATES: Record<string, string> = {
  "reflexion-loop": "evaluator-optimizer",
  router: "routing",
  "fan-out-join": "parallel-sectioning",
  "fan-out-dynamic": "map-reduce",
  "konzept-feature": "concept-feature",
  "konzept-architektur": "concept-architecture",
  "konzept-fachlich": "concept-domain",
  "entwicklung-tdd": "dev-tdd",
  "entwicklung-fehler": "dev-bugfix",
  "entwicklung-refactor": "dev-refactor",
  "gedanke-zu-konzept": "idea-to-concept",
  "konzept-wellen": "concept-waves",
  "vorhaben-ende-zu-ende": "project-end-to-end",
};

export function templateById(id: string): Graph | null {
  return TEMPLATES.find((graph) => graph.id === id) ?? null;
}
