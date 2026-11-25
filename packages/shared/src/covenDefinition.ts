import {
  COVEN_DEFINITION_MAX_BYTES,
  COVEN_INSTRUCTION_MAX_CHARS,
  COVEN_SCHEMA_VERSION,
  CovenFrontMatter,
  DEFAULT_COVEN_LIMITS,
  type CovenDefinition,
  type CovenInstructions,
  type CovenValidationIssue,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { parseDocument, stringify } from "yaml";

export type CovenParseResult =
  | { readonly ok: true; readonly definition: CovenDefinition; readonly source: string }
  | { readonly ok: false; readonly issues: ReadonlyArray<CovenValidationIssue> };

const decodeFrontMatter = Schema.decodeUnknownExit(CovenFrontMatter, {
  onExcessProperty: "error",
  errors: "all",
});

const ROLE_HEADING = /^## Role:\s*(.+?)\s*$/;

function normalizeCovenSource(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function splitFrontMatter(source: string): { yaml: string; body: string } | null {
  if (!source.startsWith("---\n")) return null;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return null;
  const after = source.slice(end + 4);
  if (after.length > 0 && !after.startsWith("\n")) return null;
  return { yaml: source.slice(4, end + 1), body: after.replace(/^\n/, "") };
}

/** Splits the Markdown body on top-level `## ` headings, ignoring headings inside code fences. */
function parseCovenInstructions(body: string): {
  instructions: CovenInstructions;
  duplicates: ReadonlyArray<string>;
} {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    if (fence === null && /^## (?!#)/.test(line)) {
      current = { heading: line.slice(3).trim(), lines: [] };
      sections.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  let mission = "";
  let sharedGuidance = "";
  const roles: Record<string, string> = {};
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const section of sections) {
    const key = section.heading.toLowerCase();
    if (seen.has(key)) duplicates.push(section.heading);
    seen.add(key);
    const text = section.lines.join("\n").trim();
    const role = ROLE_HEADING.exec(`## ${section.heading}`);
    if (role) roles[role[1]!] = text;
    else if (key === "mission") mission = text;
    else if (key === "shared guidance") sharedGuidance = text;
  }
  return { instructions: { mission, sharedGuidance, roles }, duplicates };
}

function formatSchemaIssues(error: unknown): CovenValidationIssue[] {
  if (!Schema.isSchemaError(error)) return [{ path: "", message: String(error) }];
  return error.message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce<CovenValidationIssue[]>((issues, line) => {
      const at = /at \[(.*)\]$/.exec(line);
      if (at) {
        const last = issues.at(-1);
        const path = at[1]!.replace(/"/g, "").replace(/,/g, ".");
        if (last && last.path === "") issues[issues.length - 1] = { ...last, path };
        return issues;
      }
      issues.push({ path: "", message: line.replace(/^└─\s*/, "") });
      return issues;
    }, []);
}

/** Cross-field rules the schema cannot express. */
function validateCovenSemantics(definition: CovenDefinition): CovenValidationIssue[] {
  const issues: CovenValidationIssue[] = [];
  const { frontMatter, instructions } = definition;
  const roleIds = new Set<string>();
  frontMatter.roles.forEach((role, index) => {
    if (roleIds.has(role.id)) {
      issues.push({ path: `roles.${index}.id`, message: `Duplicate role id "${role.id}".` });
    }
    roleIds.add(role.id);
    const candidateKeys = new Set<string>();
    role.candidates.forEach((candidate, candidateIndex) => {
      const key = JSON.stringify([
        candidate.providerInstanceId,
        candidate.modelId,
        candidate.options ?? null,
      ]);
      if (candidateKeys.has(key)) {
        issues.push({
          path: `roles.${index}.candidates.${candidateIndex}`,
          message: `Duplicate candidate ${candidate.providerInstanceId}/${candidate.modelId} in role "${role.id}".`,
        });
      }
      candidateKeys.add(key);
    });
  });
  const rotations = new Map<string, { readonly index: number; readonly models: string }>();
  frontMatter.roles.forEach((role, index) => {
    if (role.rotation === undefined) return;
    const path = `roles.${index}.rotation`;
    if (role.kind !== "worker") {
      issues.push({ path, message: "Only worker roles can take turns in a rotation." });
      return;
    }
    if (role.pick === "most-headroom") {
      issues.push({ path, message: "A role takes turns or picks by headroom, not both." });
    }
    if (role.candidates.length < 2) {
      issues.push({ path, message: "A rotation needs at least two models to take turns." });
    }
    const models = JSON.stringify(
      role.candidates.map((candidate) => [candidate.providerInstanceId, candidate.modelId]),
    );
    const first = rotations.get(role.rotation);
    if (first === undefined) rotations.set(role.rotation, { index, models });
    else if (first.models !== models) {
      issues.push({
        path: `roles.${index}.candidates`,
        message: `Roles in rotation "${role.rotation}" must list the same models in the same order as "${frontMatter.roles[first.index]!.id}".`,
      });
    }
  });
  frontMatter.roles.forEach((role, index) => {
    if (role.reviewedBy === undefined) return;
    const path = `roles.${index}.reviewedBy`;
    const reviewer = frontMatter.roles.find((candidate) => candidate.id === role.reviewedBy);
    if (role.kind !== "worker") {
      issues.push({ path, message: "Only worker roles can have a required reviewer." });
    } else if (reviewer === undefined) {
      issues.push({ path, message: `No role "${role.reviewedBy}" to review "${role.id}".` });
    } else if (reviewer.kind !== "worker") {
      issues.push({ path, message: "The reviewer must be a worker role." });
    } else if (reviewer.id === role.id) {
      issues.push({ path, message: "A role can't review its own work." });
    }
  });
  const orchestrators = frontMatter.roles.filter((role) => role.kind === "orchestrator");
  if (orchestrators.length !== 1) {
    issues.push({
      path: "roles",
      message: `A coven needs exactly one orchestrator role; found ${orchestrators.length}.`,
    });
  }

  const gateIds = new Set<string>();
  frontMatter.governance.gates.forEach((gate, index) => {
    const path = `governance.gates.${index}`;
    if (gateIds.has(gate.id)) issues.push({ path, message: `Duplicate gate id "${gate.id}".` });
    gateIds.add(gate.id);
    const checkRoles = (field: string, ids: ReadonlyArray<string>) => {
      ids.forEach((id) => {
        if (!roleIds.has(id)) {
          issues.push({ path: `${path}.${field}`, message: `Unknown role "${id}".` });
        }
      });
      if (new Set(ids).size !== ids.length) {
        issues.push({ path: `${path}.${field}`, message: "Role ids must be unique." });
      }
    };
    if (gate.type === "consensus") {
      checkRoles("voterRoleIds", gate.voterRoleIds);
      checkRoles("vetoRoleIds", gate.vetoRoleIds ?? []);
      const voters = gate.voterRoleIds.length;
      if (gate.quorum !== undefined && gate.quorum > voters) {
        issues.push({
          path: `${path}.quorum`,
          message: `Quorum ${gate.quorum} exceeds the ${voters} voters.`,
        });
      }
      const { kind, k } = gate.decision;
      if (kind === "k-of-n") {
        if (k === undefined || k === null) {
          issues.push({ path: `${path}.decision.k`, message: "k-of-n needs k." });
        } else if (k > voters) {
          issues.push({
            path: `${path}.decision.k`,
            message: `k=${k} exceeds the ${voters} voters.`,
          });
        }
      } else if (k !== undefined && k !== null) {
        issues.push({ path: `${path}.decision.k`, message: `k only applies to k-of-n.` });
      }
      (gate.vetoRoleIds ?? []).forEach((id) => {
        if (!gate.voterRoleIds.includes(id)) {
          issues.push({
            path: `${path}.vetoRoleIds`,
            message: `Veto role "${id}" is not a voter.`,
          });
        }
      });
    }
    if (gate.type === "review") {
      checkRoles("reviewerRoleIds", gate.reviewerRoleIds);
      if (
        gate.minimumApprovals !== undefined &&
        gate.minimumApprovals > gate.reviewerRoleIds.length
      ) {
        issues.push({
          path: `${path}.minimumApprovals`,
          message: "minimumApprovals exceeds the number of reviewers.",
        });
      }
    }
  });

  for (const roleId of Object.keys(instructions.roles)) {
    if (!roleIds.has(roleId)) {
      issues.push({
        path: `body.Role: ${roleId}`,
        message: `Instructions for unknown role "${roleId}".`,
      });
    }
  }
  const instructionTexts = [
    ["body.Mission", instructions.mission],
    ["body.Shared Guidance", instructions.sharedGuidance],
    ...Object.entries(instructions.roles).map(([id, text]) => [`body.Role: ${id}`, text]),
  ] as const;
  for (const [path, text] of instructionTexts) {
    if (text.length > COVEN_INSTRUCTION_MAX_CHARS) {
      issues.push({ path, message: `Longer than ${COVEN_INSTRUCTION_MAX_CHARS} characters.` });
    }
  }
  return issues;
}

/** Parses and validates a coven Markdown definition. Never throws. */
export function parseCovenSource(text: string): CovenParseResult {
  if (new TextEncoder().encode(text).byteLength > COVEN_DEFINITION_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: "", message: `Definition exceeds ${COVEN_DEFINITION_MAX_BYTES} bytes.` }],
    };
  }
  const source = normalizeCovenSource(text);
  const parts = splitFrontMatter(source);
  if (!parts) {
    return {
      ok: false,
      issues: [{ path: "", message: "Missing YAML front matter delimited by --- lines." }],
    };
  }
  const document = parseDocument(parts.yaml, {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
    strict: true,
  });
  const yamlProblems = [...document.errors, ...document.warnings];
  if (yamlProblems.length > 0) {
    return {
      ok: false,
      issues: yamlProblems.map((problem) => ({
        path: problem.linePos ? `yaml:${problem.linePos[0].line}` : "yaml",
        message: problem.message.split("\n")[0]!,
      })),
    };
  }
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return { ok: false, issues: [{ path: "yaml", message: String(error) }] };
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    "schemaVersion" in raw &&
    raw.schemaVersion !== COVEN_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "schemaVersion",
          message: `Unsupported schema version ${JSON.stringify(raw.schemaVersion)}; this build reads ${COVEN_SCHEMA_VERSION}.`,
        },
      ],
    };
  }
  const decoded = decodeFrontMatter(raw);
  if (Exit.isFailure(decoded)) {
    return { ok: false, issues: formatSchemaIssues(Cause.squash(decoded.cause)) };
  }
  const { instructions, duplicates } = parseCovenInstructions(parts.body);
  const definition: CovenDefinition = { frontMatter: decoded.value, instructions };
  const issues = [
    ...duplicates.map((heading) => ({
      path: `body.${heading}`,
      message: `Duplicate section "## ${heading}".`,
    })),
    ...validateCovenSemantics(definition),
  ];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, definition, source };
}

/** Replaces the front matter of `source`, keeping the user's Markdown body byte-for-byte. */
export function withCovenFrontMatter(
  source: string,
  update: (frontMatter: Record<string, unknown>) => Record<string, unknown>,
): string {
  const normalized = normalizeCovenSource(source);
  const parts = splitFrontMatter(normalized);
  const current = parts ? (parseDocument(parts.yaml).toJS() as Record<string, unknown>) : {};
  const body = parts ? parts.body : normalized;
  return `---\n${stringify(update(current ?? {}), { lineWidth: 0, aliasDuplicateObjects: false })}---\n${body}`;
}

/** Stable digest over the semantic content: parsed front matter and section text. */
export async function covenDigest(definition: CovenDefinition): Promise<string> {
  const canonical = JSON.stringify(definition, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  const bytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function slugifyCovenName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "coven";
}

/** A starter definition. Candidates come from the caller so no provider identity is invented. */
export function starterCovenSource(input: {
  readonly id: string;
  readonly name: string;
  readonly leader: { readonly providerInstanceId: string; readonly modelId: string };
  readonly mission?: string | undefined;
}): string {
  const frontMatter = {
    schemaVersion: COVEN_SCHEMA_VERSION,
    id: input.id,
    slug: slugifyCovenName(input.name),
    name: input.name,
    revision: 1,
    description: "",
    aliases: [],
    roles: [
      {
        id: "lead",
        kind: "orchestrator",
        name: "Orchestrator",
        responsibility: "Plans, delegates, and decides when the work is done",
        candidates: [{ ...input.leader }],
      },
      {
        id: "builder",
        kind: "worker",
        name: "Builder",
        responsibility: "Implements the tasks the orchestrator assigns",
        candidates: [{ ...input.leader }],
      },
    ],
    governance: { defaultWorkflow: "orchestrator", gates: [] },
    workspace: {
      strategy: "hybrid",
      parallelWriters: "isolated-worktrees",
      sharedWrites: "exclusive-lease",
    },
    autonomy: {
      initialPlanApproval: true,
      scopeChanges: "approval-required",
      externalSideEffects: "approval-required",
      permissionCeiling: "inherit-t3",
    },
    limits: DEFAULT_COVEN_LIMITS,
  };
  return `---\n${stringify(frontMatter, { lineWidth: 0, aliasDuplicateObjects: false })}---\n# ${input.name}\n\n## Mission\n${input.mission?.trim() ? `${input.mission.trim()}\n` : ""}\n## Shared Guidance\nThe orchestrator owns assignments. Workers report to the orchestrator, not one another.\n\n## Role: lead\nCreate an initial plan for approval, then coordinate the work.\n\n## Role: builder\nMake focused changes and report what changed and how you verified it.\n`;
}
