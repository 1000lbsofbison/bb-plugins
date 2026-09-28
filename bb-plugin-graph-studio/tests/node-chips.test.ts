// What a node card says about itself besides its name. Every chip is pinned
// in both directions: shown when its fact is set, absent when it is not.
import { describe, expect, it } from "vitest";
import { nodeExecution, nodeSchema } from "../lib/graph";
import { nodeChips } from "../components/graph-canvas";

const chipsOf = (input: Record<string, unknown>) => {
  const node = nodeSchema.parse({ id: "n", label: "N", ...input });
  return nodeChips(node, nodeExecution(node)).map((chip) => chip.text);
};

describe("node chips", () => {
  it("shows the explicit model, reasoning level and fast tier", () => {
    expect(
      chipsOf({
        providerId: "claude-code",
        model: "claude-opus-5-5",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ).toEqual(["opus-5-5", "high", "⚡ fast"]);
  });

  it("says an agent without a model inherits, and adds nothing unset", () => {
    expect(chipsOf({ kind: "agent" })).toEqual(["inherits model"]);
  });

  it("keeps the default tier off the card", () => {
    expect(
      chipsOf({ providerId: "pi", model: "glm", serviceTier: "default" }),
    ).toEqual(["glm"]);
  });

  it("gives kinds that spawn no worker no model chip", () => {
    expect(chipsOf({ kind: "human" })).toEqual([]);
    expect(chipsOf({ kind: "note" })).toEqual([]);
  });

  it("counts skills and result fields only when there are any", () => {
    expect(
      chipsOf({ kind: "note", skills: ["tdd", "diagnose"], fields: [{ name: "verdict" }] }),
    ).toEqual(["2 skills", "1 field"]);
    expect(chipsOf({ kind: "note", skills: [], fields: [] })).toEqual([]);
  });
});

describe("node colour", () => {
  const parse = (color: unknown) => nodeSchema.safeParse({ id: "n", label: "N", color });

  it("accepts a palette colour, in any case", () => {
    expect(parse("#0070f3").data?.color).toBe("#0070F3");
  });

  it("stays neutral by default and rejects colours outside the palette", () => {
    expect(nodeSchema.parse({ id: "n", label: "N" }).color).toBeNull();
    expect(parse("#123456").success).toBe(false);
    expect(parse("red").success).toBe(false);
  });
});
