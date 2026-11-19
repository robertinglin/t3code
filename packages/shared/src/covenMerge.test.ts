import { describe, expect, it } from "vite-plus/test";

import { mergeCovenSources, resolveCovenMerge } from "./covenMerge.ts";

const base = ["a", "b", "c", "d", "e"].join("\n");

describe("mergeCovenSources", () => {
  it("merges changes made on different lines", () => {
    const mine = ["a", "B", "c", "d", "e"].join("\n");
    const theirs = ["a", "b", "c", "d", "E", "f"].join("\n");
    const result = mergeCovenSources(base, mine, theirs);
    expect(result.conflictCount).toBe(0);
    expect(resolveCovenMerge(result, [])).toBe(["a", "B", "c", "d", "E", "f"].join("\n"));
  });

  it("takes one side when the other did not change", () => {
    const theirs = ["x", "b", "c"].join("\n");
    expect(resolveCovenMerge(mergeCovenSources(base, base, theirs), [])).toBe(theirs);
    expect(resolveCovenMerge(mergeCovenSources(base, theirs, base), [])).toBe(theirs);
  });

  it("treats identical edits as clean", () => {
    const both = ["a", "z", "c", "d", "e"].join("\n");
    const result = mergeCovenSources(base, both, both);
    expect(result.conflictCount).toBe(0);
    expect(resolveCovenMerge(result, [])).toBe(both);
  });

  it("reports overlapping edits and resolves each choice", () => {
    const mine = ["a", "mine", "c", "d", "e"].join("\n");
    const theirs = ["a", "theirs", "c", "d", "e"].join("\n");
    const result = mergeCovenSources(base, mine, theirs);
    expect(result.conflictCount).toBe(1);
    expect(result.chunks).toContainEqual({
      kind: "conflict",
      base: ["b"],
      mine: ["mine"],
      theirs: ["theirs"],
    });
    expect(resolveCovenMerge(result, ["mine"])).toBe(mine);
    expect(resolveCovenMerge(result, ["theirs"])).toBe(theirs);
    expect(resolveCovenMerge(result, ["both"])).toBe(
      ["a", "mine", "theirs", "c", "d", "e"].join("\n"),
    );
  });

  it("handles inserts at the same spot as a conflict", () => {
    const result = mergeCovenSources("a\nb", "a\nm\nb", "a\nt\nb");
    expect(result.conflictCount).toBe(1);
    expect(resolveCovenMerge(result, ["theirs"])).toBe("a\nt\nb");
  });
});
