// The agent tools, checked against their source.
//
// Not the usual way round, and it needs a reason: a plugin tool can only be
// invoked through a running host, and the SDK's host harness reaches RPC
// methods, not `bb.agents.registerTool`. The alternative to reading the source
// is not a better test — it is no test, and this is the file where the fix
// below would silently regress.
//
// What it guards is one mistake that had already been made: `graph_studio_run`
// took `threadId` as a *parameter*, so the calling model had to know its own
// thread id. Left out, the default was null and `startRun` threw "a run needs
// a parent thread" — after the model had composed its input. The context is
// handed to every tool as `ctx`; asking the model for it was always wrong.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TEMPLATES } from "../lib/templates";

const source = readFileSync("server.ts", "utf8");

/** The `registerTool({...})` block for one tool. */
function toolSource(name: string): string {
  const start = source.indexOf(`name: "${name}"`);
  expect(start, `${name} should be registered`).toBeGreaterThan(-1);
  const end = source.indexOf("registerTool", start);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("graph_studio_run", () => {
  it("takes the thread and project from the call context, not from the model", () => {
    const tool = toolSource("graph_studio_run");
    expect(tool).toContain("ctx.threadId");
    expect(tool).toContain("ctx.projectId");
  });

  /**
   * The negative case, and the actual regression: a `threadId` parameter is
   * the model guessing at something the host already knows.
   */
  it("does not ask the model for a thread id", () => {
    const tool = toolSource("graph_studio_run");
    const parameters = tool.slice(tool.indexOf("parameters:"), tool.indexOf("execute:"));
    expect(parameters).not.toContain("threadId");
  });

  /**
   * The description is the only thing the calling model reads. If it does not
   * say that `input` is all the run will ever see, the model passes along the
   * user's last sentence — and the graph starts from nothing, which is exactly
   * the gap this tool exists to close.
   */
  it("tells the caller that input is the run's only context", () => {
    const tool = toolSource("graph_studio_run");
    expect(tool).toMatch(/only context/i);
    expect(tool).toMatch(/attachments/i);
  });
});

/**
 * The help text is where someone looks for what is possible, and the best way
 * to start a run is the one the command list cannot show — because it is not a
 * command. Until now it existed only in the README and in the tool description,
 * which no human reads.
 *
 * Written as a positive test on purpose: CLAUDE.md now asks for one alongside
 * every negative case, because a check that something is absent stays green
 * when it is absent everywhere.
 */
describe("the help text points at the agent route", () => {
  const help = source.slice(source.indexOf("const usageText"), source.indexOf("bb.cli.register"));

  it("says that the task is the run's only context", () => {
    expect(help).toMatch(/only context/i);
  });

  it("shows the sentence to say, not just the rule", () => {
    expect(help).toMatch(/Summarise what we settled here/);
  });

  /** A graph id in an example goes stale; this one has to exist. */
  it("names a template that is actually in the library", () => {
    const quoted = help.match(/start ([a-z][a-z0-9-]*) with it/);
    expect(quoted, "the example should name a graph").not.toBeNull();
    expect(TEMPLATES.map((graph) => graph.id)).toContain(quoted![1]);
  });
});
