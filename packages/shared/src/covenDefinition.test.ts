import { describe, expect, it } from "vite-plus/test";

import { parseCovenCommand, resolveCovenName } from "./covenCommands.ts";
import {
  covenDigest,
  parseCovenSource,
  starterCovenSource,
  withCovenFrontMatter,
} from "./covenDefinition.ts";

const leader = { providerInstanceId: "codex", modelId: "gpt-5" };

function withWorker(source: string, extraFrontMatter = ""): string {
  return source
    .replace(
      "    candidates:\n      - providerInstanceId: codex\n        modelId: gpt-5\n",
      `    candidates:\n      - providerInstanceId: codex\n        modelId: gpt-5\n  - id: tester\n    kind: worker\n    name: Tester\n    responsibility: Implements tasks\n    candidates:\n      - providerInstanceId: claude\n        modelId: opus\n      - providerInstanceId: codex\n        modelId: gpt-5\n${extraFrontMatter}`,
    )
    .concat("\n## Role: tester\nWrite code with tests.\n");
}

describe("parseCovenSource", () => {
  it("accepts the starter definition", () => {
    const result = parseCovenSource(starterCovenSource({ id: "cv1", name: "Sales Team", leader }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.frontMatter.slug).toBe("sales-team");
    expect(result.definition.instructions.roles["lead"]).toContain("initial plan");
  });

  it("accepts a worker with an ordered fallback chain", () => {
    const result = parseCovenSource(
      withWorker(starterCovenSource({ id: "cv1", name: "T", leader })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tester = result.definition.frontMatter.roles.find((role) => role.id === "tester");
    expect(tester?.candidates.map((candidate) => candidate.providerInstanceId)).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("rejects missing front matter, unknown keys and duplicate keys", () => {
    expect(parseCovenSource("# just markdown").ok).toBe(false);
    const starter = starterCovenSource({ id: "cv1", name: "T", leader });
    const unknown = parseCovenSource(starter.replace("revision: 1", "revision: 1\nsurprise: true"));
    expect(unknown.ok).toBe(false);
    const duplicate = parseCovenSource(starter.replace("revision: 1", "revision: 1\nrevision: 2"));
    expect(duplicate.ok).toBe(false);
  });

  it("requires exactly one orchestrator", () => {
    const starter = starterCovenSource({ id: "cv1", name: "T", leader });
    const result = parseCovenSource(starter.replace("kind: orchestrator", "kind: worker"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes("orchestrator"))).toBe(true);
  });

  it("rejects gates that name unknown roles", () => {
    const starter = starterCovenSource({ id: "cv1", name: "T", leader });
    const gated = starter.replace(
      "gates: []",
      "gates:\n    - id: review\n      type: review\n      on: before-completion\n      when:\n        kind: always\n      reviewerRoleIds: [ghost]\n      minimumApprovals: 1",
    );
    const result = parseCovenSource(gated);
    expect(result.ok).toBe(false);
  });

  it("rejects instructions for roles that do not exist", () => {
    const starter = starterCovenSource({ id: "cv1", name: "T", leader });
    expect(parseCovenSource(`${starter}\n## Role: ghost\nBoo.\n`).ok).toBe(false);
  });

  it("keeps the digest stable across formatting changes", async () => {
    const starter = starterCovenSource({ id: "cv1", name: "T", leader });
    const a = parseCovenSource(starter);
    const b = parseCovenSource(starter.replace(/\n/g, "\r\n"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(await covenDigest(a.definition)).toBe(await covenDigest(b.definition));
  });

  it("accepts a round-robin rotation and rejects mismatched ones", () => {
    const pool = [
      { providerInstanceId: "claude", modelId: "opus" },
      { providerInstanceId: "codex", modelId: "gpt-5" },
    ];
    const withRoles = (reviewerModels: typeof pool, pick?: "most-headroom") =>
      withCovenFrontMatter(starterCovenSource({ id: "rr", name: "RR", leader }), (frontMatter) => ({
        ...frontMatter,
        roles: [
          ...(frontMatter.roles as ReadonlyArray<unknown>),
          {
            id: "implementer",
            kind: "worker",
            name: "Implementer",
            responsibility: "Implements",
            rotation: "loop",
            candidates: pool,
            ...(pick ? { pick } : {}),
          },
          {
            id: "reviewer",
            kind: "worker",
            name: "Reviewer",
            responsibility: "Reviews",
            rotation: "loop",
            candidates: reviewerModels,
          },
        ],
      }));
    expect(parseCovenSource(withRoles(pool)).ok).toBe(true);
    const mismatched = parseCovenSource(withRoles(pool.toReversed()));
    expect(!mismatched.ok && mismatched.issues.map((issue) => issue.message).join()).toContain(
      'rotation "loop" must list the same models',
    );
    expect(parseCovenSource(withRoles(pool, "most-headroom")).ok).toBe(false);
  });

  it("rewrites front matter fields without touching the body", () => {
    const starter = starterCovenSource({ id: "cv1", name: "T", leader });
    const updated = withCovenFrontMatter(starter, (frontMatter) => ({
      ...frontMatter,
      revision: 4,
    }));
    const result = parseCovenSource(updated);
    expect(result.ok && result.definition.frontMatter.revision).toBe(4);
    expect(updated.endsWith(starter.slice(starter.indexOf("# T")))).toBe(true);
  });
});

describe("parseCovenCommand", () => {
  it("parses change forms with quoting and case", () => {
    expect(parseCovenCommand("/coven change Sales")).toEqual({ kind: "change", name: "Sales" });
    expect(parseCovenCommand('/COVEN change to "Sales Team"')).toEqual({
      kind: "change",
      name: "Sales Team",
    });
    expect(parseCovenCommand("/coven off")).toEqual({ kind: "off" });
    expect(parseCovenCommand("/coven delete")).toEqual({ kind: "delete", name: null });
    expect(parseCovenCommand('/coven delete "Game Design"')).toEqual({
      kind: "delete",
      name: "Game Design",
    });
    expect(parseCovenCommand("/coven")).toEqual({ kind: "help" });
    expect(parseCovenCommand("/coven show")).toEqual({ kind: "show", name: null });
  });

  it("parses build commands", () => {
    expect(parseCovenCommand("/coven-build a sales team")).toEqual({
      kind: "build",
      prompt: "a sales team",
    });
    expect(parseCovenCommand("/coven-build edit sales")).toEqual({
      kind: "build-edit",
      name: "sales",
    });
    expect(parseCovenCommand('/coven-edit "Open Gemini"')).toEqual({
      kind: "build-edit",
      name: "Open Gemini",
    });
    expect(parseCovenCommand("/coven-edit")).toEqual({ kind: "build-edit", name: null });
    expect(parseCovenCommand("/coven-editor")).toBeNull();
  });

  it("ignores other commands and flags unknown verbs", () => {
    expect(parseCovenCommand("/covenant")).toBeNull();
    expect(parseCovenCommand("hello /coven list")).toBeNull();
    expect(parseCovenCommand("/coven dance")?.kind).toBe("invalid");
  });

  it("parses run control and approval commands", () => {
    expect(parseCovenCommand("/coven pause")).toEqual({ kind: "pause" });
    expect(parseCovenCommand("/coven Stop")).toEqual({ kind: "stop" });
    expect(parseCovenCommand("/coven approve")).toEqual({ kind: "approve", note: null });
    expect(parseCovenCommand('/coven reject "needs tests first"')).toEqual({
      kind: "reject",
      note: "needs tests first",
    });
  });
});

describe("resolveCovenName", () => {
  const covens = [
    { id: "a", slug: "sales-team", name: "Sales Team", aliases: ["sales"] },
    { id: "b", slug: "sales-ops", name: "Sales Ops", aliases: [] },
    { id: "c", slug: "research", name: "Research", aliases: [] },
  ];

  it("prefers exact alias matches over prefixes", () => {
    expect(resolveCovenName("SALES", covens).match?.id).toBe("a");
    expect(resolveCovenName("res", covens).match?.id).toBe("c");
  });

  it("reports ambiguous prefixes", () => {
    const result = resolveCovenName("sales-", covens);
    expect(result.match).toBeNull();
    expect(result.ambiguous.map((coven) => coven.id)).toEqual(["a", "b"]);
  });
});
