// Parsing a worker's answer into declared fields.
//
// This is the joint that replaces substring matching, so it gets the harshest
// tests: real answers are prose with a JSON block somewhere at the end, and a
// malformed one must fail loudly (retryable) rather than quietly.
import { describe, expect, it } from "vitest";
import {
  FieldContractError,
  fieldContract,
  fieldSchema,
  parseFields,
  type GraphField,
} from "../lib/graph";

const field = (input: Partial<GraphField> & { name: string }): GraphField =>
  fieldSchema.parse(input);

const verdict = field({
  name: "verdict",
  type: "enum",
  options: ["APPROVE", "REWORK", "BLOCK"],
});

describe("fieldContract", () => {
  it("is empty when nothing is declared", () => {
    expect(fieldContract([])).toBe("");
  });

  it("names every key and spells out enum options", () => {
    const contract = fieldContract([verdict, field({ name: "score", type: "number" })]);
    expect(contract).toContain('"verdict"');
    expect(contract).toContain('"APPROVE"');
    expect(contract).toContain('"score"');
    expect(contract).toContain("a number");
  });
});

describe("parseFields", () => {
  it("returns nothing when no fields are declared", () => {
    expect(parseFields([], "some text")).toEqual({});
  });

  it("reads a fenced json block after prose", () => {
    const answer = [
      "A long rationale that happens to mention REWORK and BLOCK.",
      "```json",
      '{ "verdict": "APPROVE" }',
      "```",
    ].join("\n");
    expect(parseFields([verdict], answer)).toEqual({ verdict: "APPROVE" });
  });

  it("takes the LAST block when the worker shows an example first", () => {
    const answer = [
      "An example would look like this:",
      "```json",
      '{ "verdict": "BLOCK" }',
      "```",
      "My actual verdict:",
      "```json",
      '{ "verdict": "APPROVE" }',
      "```",
    ].join("\n");
    expect(parseFields([verdict], answer)).toEqual({ verdict: "APPROVE" });
  });

  it("falls back to a bare object without a fence", () => {
    expect(parseFields([verdict], 'Fazit: { "verdict": "REWORK" }')).toEqual({
      verdict: "REWORK",
    });
  });

  it("handles nested braces in the bare-object fallback", () => {
    const answer = 'Text { "verdict": "APPROVE", "meta": { "a": 1 } }';
    expect(parseFields([verdict], answer)).toEqual({ verdict: "APPROVE" });
  });

  it("matches an enum case-insensitively but stores the declared spelling", () => {
    expect(parseFields([verdict], '{ "verdict": "approve" }')).toEqual({
      verdict: "APPROVE",
    });
  });

  it("coerces numbers and booleans sent as strings", () => {
    const fields = [
      field({ name: "score", type: "number" }),
      field({ name: "done", type: "boolean" }),
    ];
    expect(parseFields(fields, '{ "score": "42", "done": "true" }')).toEqual({
      score: 42,
      done: true,
    });
  });

  it("keeps a boolean false rather than treating it as missing", () => {
    const done = field({ name: "done", type: "boolean" });
    expect(parseFields([done], '{ "done": false }')).toEqual({ done: false });
  });

  it("rejects an answer with no JSON at all", () => {
    expect(() => parseFields([verdict], "Prose only.")).toThrow(
      FieldContractError,
    );
  });

  it("rejects unreadable JSON", () => {
    expect(() => parseFields([verdict], "```json\n{ verdict: }\n```")).toThrow(
      /cannot be read/,
    );
  });

  it("rejects a missing field by name", () => {
    expect(() => parseFields([verdict], '{ "urteil": "APPROVE" }')).toThrow(
      /"verdict" is missing/,
    );
  });

  it("rejects a value outside the enum and lists what is allowed", () => {
    expect(() => parseFields([verdict], '{ "verdict": "VIELLEICHT" }')).toThrow(
      /APPROVE, REWORK, BLOCK/,
    );
  });

  it("rejects a non-numeric number", () => {
    const score = field({ name: "score", type: "number" });
    expect(() => parseFields([score], '{ "score": "viele" }')).toThrow(
      /is not a number/,
    );
  });

  it("rejects an array where an object is required", () => {
    expect(() => parseFields([verdict], "```json\n[1,2]\n```")).toThrow(
      FieldContractError,
    );
  });
});

describe("list fields", () => {
  const dateien: GraphField = fieldSchema.parse({ name: "dateien", type: "list" });

  it("reads a JSON array into a list of strings", () => {
    const answer = '```json\n{ "dateien": ["a.ts", "b.ts"] }\n```';
    expect(parseFields([dateien], answer)).toEqual({ dateien: ["a.ts", "b.ts"] });
  });

  // "Nothing changed" is a real answer, not a broken contract — the fan-out
  // simply has no work. Failing here would retry a worker that was right.
  it("accepts an empty list", () => {
    expect(parseFields([dateien], '```json\n{ "dateien": [] }\n```')).toEqual({
      dateien: [],
    });
  });

  it("drops blank entries rather than fanning out over an empty task", () => {
    const answer = '```json\n{ "dateien": ["a.ts", "  ", ""] }\n```';
    expect(parseFields([dateien], answer)).toEqual({ dateien: ["a.ts"] });
  });

  it("rejects a value that is not an array", () => {
    expect(() =>
      parseFields([dateien], '```json\n{ "dateien": "a.ts, b.ts" }\n```'),
    ).toThrow(FieldContractError);
  });

  it("tells the worker the expected shape in the contract", () => {
    expect(fieldContract([dateien])).toMatch(/a list of strings/);
  });
});
