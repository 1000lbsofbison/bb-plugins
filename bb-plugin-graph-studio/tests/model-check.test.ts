import { describe, expect, it } from "vitest";
import { checkModels, type ModelCatalog } from "../lib/model-check";

const providers = [
  { id: "claude-code", available: true },
  { id: "pi", available: true },
  { id: "off", available: false },
];

// Mirrors what BB answered live (BBP-21): one catalogue per provider.
const catalogs: Record<string, ModelCatalog> = {
  "claude-code": {
    providers,
    models: [
      { id: "claude-opus-5-5", model: "claude-opus-5-5" },
      { id: "claude-haiku-4-5-20251001", model: "claude-haiku-4-5-20251001" },
    ],
    modelLoadError: null,
  },
  pi: { providers, models: [{ id: "local/glm-big", model: "glm-big" }], modelLoadError: null },
};

const load = async (providerId: string) => {
  const catalog = catalogs[providerId];
  if (!catalog) return { providers, models: [], modelLoadError: null };
  return catalog;
};

describe("checkModels", () => {
  it("accepts a model the named provider lists, even if it is not the default provider", async () => {
    const asked: string[] = [];
    const result = await checkModels(
      [
        { label: "Haiku", providerId: "claude-code", model: "claude-haiku-4-5-20251001" },
        { label: "Pi", providerId: "pi", model: "glm-big" },
      ],
      async (id) => (asked.push(id), load(id)),
    );
    expect(result).toEqual({ problems: [], warnings: [] });
    expect(asked).toEqual(["claude-code", "pi"]);
  });

  it("reports a model the provider's catalogue does not list", async () => {
    const result = await checkModels(
      [{ label: "Bogus", providerId: "claude-code", model: "claude-bogus-9" }],
      load,
    );
    expect(result.problems).toEqual([
      '"Bogus" names the model "claude-bogus-9", which does not appear in the catalogue of "claude-code"',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("does not accept another provider's model under the wrong provider", async () => {
    const result = await checkModels(
      [{ label: "Mixed", providerId: "claude-code", model: "glm-big" }],
      load,
    );
    expect(result.problems).toHaveLength(1);
  });

  it("reports an unknown or unavailable provider", async () => {
    const result = await checkModels(
      [
        { label: "Nope", providerId: "nope", model: "x" },
        { label: "Off", providerId: "off", model: "x" },
      ],
      load,
    );
    expect(result.problems).toEqual([
      '"Nope" names the provider "nope", which this machine does not offer',
      '"Off" names the provider "off", which this machine does not offer',
    ]);
  });

  it("warns instead of refusing when the catalogue is empty, failed or unreadable", async () => {
    const result = await checkModels(
      [
        { label: "Empty", providerId: "pi", model: "x" },
        { label: "Failed", providerId: "claude-code", model: "y" },
        { label: "Throws", providerId: "boom", model: "z" },
      ],
      async (id) => {
        if (id === "pi") return { providers, models: [], modelLoadError: null };
        if (id === "claude-code") {
          return {
            providers,
            models: [],
            modelLoadError: { providerId: "claude-code", code: "timeout", detail: null },
          };
        }
        throw new Error("network down");
      },
    );
    expect(result.problems).toEqual([]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("empty");
    expect(result.warnings[1]).toContain("unavailable (timeout)");
    expect(result.warnings[2]).toContain("network down");
  });

  it("asks each provider only once", async () => {
    let calls = 0;
    await checkModels(
      [
        { label: "A", providerId: "claude-code", model: "claude-opus-5-5" },
        { label: "B", providerId: "claude-code", model: "claude-haiku-4-5-20251001" },
      ],
      async (id) => (calls++, load(id)),
    );
    expect(calls).toBe(1);
  });
});
