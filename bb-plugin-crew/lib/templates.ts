// Bundled crew files. Code, not database rows (AGENTS.md): a stored crew with
// a template's name would otherwise shadow the template.
import type { CrewSpecInput } from "./spec";

export type CrewTemplate = { id: string; summary: string; spec: CrewSpecInput };

const pair: CrewSpecInput = {
  version: "1",
  name: "pair",
  summary: "Owner builds, checker verifies the exact candidate.",
  instructions: "Trust but verify. Every handoff names the exact commit or file set.",
  groups: [
    {
      id: "dev",
      members: [
        {
          id: "owner",
          lead: true,
          provider: "claude-code",
          model: "claude-sonnet-5",
          role: "Implements exactly one bounded change at a time and hands it to dev-check.",
        },
        {
          id: "check",
          provider: "claude-code",
          model: "claude-sonnet-5",
          permissions: "ask",
          role: "Checks exactly the candidate named in the handoff.",
        },
      ],
    },
  ],
  links: [
    { from: "dev-owner", to: "dev-check", kind: "works_with" },
    { from: "dev-check", to: "dev-owner", kind: "escalates_to" },
  ],
};

const trio: CrewSpecInput = {
  version: "1",
  name: "trio",
  summary: "Lead plans, impl builds, review checks.",
  instructions: "Every handoff names the exact commit or file set.",
  groups: [
    {
      id: "orch",
      members: [
        {
          id: "lead",
          lead: true,
          provider: "claude-code",
          model: "claude-opus-5-5",
          role: "Plans the work, assigns it to dev-impl, merges after review, reports to the user.",
        },
      ],
    },
    {
      id: "dev",
      members: [
        {
          id: "impl",
          provider: "claude-code",
          model: "claude-sonnet-5",
          role: "Implements exactly one bounded change at a time.",
        },
        {
          id: "review",
          provider: "claude-code",
          model: "claude-sonnet-5",
          permissions: "ask",
          role: "Reviews exactly the candidate named in the handoff.",
        },
      ],
    },
  ],
  links: [
    { from: "orch-lead", to: "dev-impl", kind: "assigns_to" },
    { from: "orch-lead", to: "dev-review", kind: "assigns_to" },
    { from: "dev-impl", to: "dev-review", kind: "works_with" },
    { from: "dev-review", to: "orch-lead", kind: "escalates_to" },
  ],
};

const research: CrewSpecInput = {
  version: "1",
  name: "research",
  summary: "A lead splits a question, two researchers dig, the lead merges the findings.",
  instructions: "Cite primary sources. Say what you did not verify.",
  permissions: "ask",
  groups: [
    {
      id: "orch",
      members: [
        {
          id: "lead",
          lead: true,
          provider: "claude-code",
          model: "claude-opus-5-5",
          role: "Splits the question, assigns parts, merges the findings into one answer.",
        },
      ],
    },
    {
      id: "res",
      members: [
        { id: "one", provider: "claude-code", model: "claude-sonnet-5", role: "Researches the part assigned to you." },
        { id: "two", provider: "claude-code", model: "claude-sonnet-5", role: "Researches the part assigned to you." },
      ],
    },
  ],
  links: [
    { from: "orch-lead", to: "res-one", kind: "assigns_to" },
    { from: "orch-lead", to: "res-two", kind: "assigns_to" },
    { from: "res-one", to: "orch-lead", kind: "escalates_to" },
    { from: "res-two", to: "orch-lead", kind: "escalates_to" },
  ],
};

export const TEMPLATES: readonly CrewTemplate[] = [
  { id: "pair", summary: pair.summary ?? "", spec: pair },
  { id: "trio", summary: trio.summary ?? "", spec: trio },
  { id: "research", summary: research.summary ?? "", spec: research },
];

export function findTemplate(id: string): CrewTemplate | null {
  return TEMPLATES.find((template) => template.id === id) ?? null;
}
