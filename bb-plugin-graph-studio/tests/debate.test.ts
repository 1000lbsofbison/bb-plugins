// The debate template, run against a fake host.
//
// Roadmap #15 listed "mesh / debate" as something the plugin could not do —
// "the edges would have to appear at run time". Roadmap #18 said: try it as a
// template first. This file is that trial, and its claims are the ones that
// decide whether the shape holds without a new engine feature:
//
// - every position speaks once per round, in its own thread;
// - the moderator runs once per round, not once per position — the early
//   start that a join inside a cycle would suffer (see `joinSources`);
// - the second round sees the first, so positions can answer each other;
// - the loop has three ways out, and each of them actually fires.
import { describe, expect, it } from "vitest";
import { emptyRunState, validateGraph } from "../lib/graph";
import { compileGraph, type RuntimeHost } from "../lib/runtime";
import { templateById } from "../lib/templates";

const fenced = (fields: Record<string, unknown>) =>
  `Notes.\n\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``;

const framed = (...positions: string[]) =>
  `The question, sharpened.\n\n${JSON.stringify({ positions })}`.replace(
    /\n\n(\{.*)$/,
    (_, json) => `\n\n\`\`\`json\n${json}\n\`\`\``,
  );

/**
 * Answers each node from a script. Positions reply with their own stance, so
 * the moderator's prompt shows exactly which branches reached it and when.
 */
function debateHost(moderatorRounds: Array<Record<string, unknown>>) {
  const prompts: Array<{ nodeId: string; prompt: string }> = [];
  const byThread = new Map<string, { nodeId: string; prompt: string }>();
  let n = 0;
  let moderated = 0;
  const host: RuntimeHost = {
    async spawn({ nodeId, prompt }) {
      prompts.push({ nodeId, prompt });
      n += 1;
      const threadId = `thr_${nodeId}_${n}`;
      byThread.set(threadId, { nodeId, prompt });
      return threadId;
    },
    async awaitThread(threadId) {
      const { nodeId, prompt } = byThread.get(threadId)!;
      if (nodeId === "frame") return framed("Split it", "Keep it", "Split later");
      if (nodeId === "speak") {
        const stance = prompt.match(/You argue this position:\n\n(.*)\n/)![1];
        return `Statement for: ${stance}`;
      }
      if (nodeId === "moderate") {
        const round = moderatorRounds[Math.min(moderated, moderatorRounds.length - 1)]!;
        moderated += 1;
        return fenced(round);
      }
      return "Verdict text.";
    },
    async sendMessage() {},
    async loadDialog() {
      return null;
    },
    async saveDialog() {},
    async onNodeStart() {
      return "node-run";
    },
    async onNodeThread() {},
    async onNodeFinish() {},
    async onStateChange() {},
    log() {},
  };
  const ran = (nodeId: string) => prompts.filter((entry) => entry.nodeId === nodeId);
  return { host, prompts, ran };
}

const debate = () => templateById("debate")!;
const going = { settled: false, progressed: true };
const settled = { settled: true, progressed: true };
const stalled = { settled: false, progressed: false };

async function run(moderatorRounds: Array<Record<string, unknown>>) {
  const fake = debateHost(moderatorRounds);
  const app = compileGraph(debate(), fake.host);
  await app.invoke(emptyRunState("Monolith or not?"), { recursionLimit: 100 });
  return fake;
}

describe("the debate template", () => {
  it("is a valid graph — no errors, and no early-start warning", () => {
    const problems = validateGraph(debate());
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    expect(problems.map((p) => p.message).join("\n")).not.toMatch(/once per branch/);
  });

  it("lets every position speak once per round, and the moderator once per round", async () => {
    const { ran } = await run([going, going, going]);
    // Three rounds: the third is the last one `visitsBelow 3` allows.
    expect(ran("speak")).toHaveLength(9);
    expect(ran("moderate")).toHaveLength(3);
    expect(ran("verdict")).toHaveLength(1);
  });

  /** The claim that makes this a debate rather than three votes in a row. */
  it("shows the second round what the first round said", async () => {
    const { ran } = await run([going, settled]);
    const speeches = ran("speak");
    const first = speeches.slice(0, 3);
    const second = speeches.slice(3, 6);
    for (const entry of first) {
      expect(entry.prompt).not.toContain("Statement for:");
    }
    for (const entry of second) {
      expect(entry.prompt).toContain("Statement for: Split it");
      expect(entry.prompt).toContain("Statement for: Keep it");
      expect(entry.prompt).toContain("Statement for: Split later");
      expect(entry.prompt).toContain("Notes.");
    }
  });

  it("gives the moderator the whole round, not one position", async () => {
    const { ran } = await run([settled]);
    const [moderate] = ran("moderate");
    expect(moderate!.prompt).toContain("Statement for: Split it");
    expect(moderate!.prompt).toContain("Statement for: Keep it");
    expect(moderate!.prompt).toContain("Statement for: Split later");
  });

  it("stops after the first round when the moderator calls it settled", async () => {
    const { ran } = await run([settled]);
    expect(ran("speak")).toHaveLength(3);
    expect(ran("moderate")).toHaveLength(1);
    expect(ran("verdict")).toHaveLength(1);
  });

  it("stops when a round brought nothing new, even though it is not settled", async () => {
    const { ran } = await run([going, stalled]);
    expect(ran("moderate")).toHaveLength(2);
    expect(ran("verdict")).toHaveLength(1);
  });

  /** The negative case for the exits: a going debate does go on. */
  it("does not stop after one round while the moderator sees movement", async () => {
    const { ran } = await run([going, settled]);
    expect(ran("speak")).toHaveLength(6);
    expect(ran("moderate")).toHaveLength(2);
  });

  it("hands the verdict the final round and the moderator's notes", async () => {
    const { ran } = await run([settled]);
    const [verdict] = ran("verdict");
    expect(verdict!.prompt).toContain("Statement for: Split it");
    expect(verdict!.prompt).toContain("Notes.");
  });
});
