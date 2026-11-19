/**
 * Line-based three-way merge for coven definitions. Used when the user's
 * edits and another writer (the AI builder, or a save from elsewhere) both
 * changed the same base text: changes on one side only merge cleanly, and
 * overlapping changes come back as conflicts for the user to settle.
 */

export type CovenMergeChunk =
  | { readonly kind: "same"; readonly lines: ReadonlyArray<string> }
  | {
      readonly kind: "conflict";
      readonly base: ReadonlyArray<string>;
      readonly mine: ReadonlyArray<string>;
      readonly theirs: ReadonlyArray<string>;
    };

export interface CovenMergeResult {
  readonly chunks: ReadonlyArray<CovenMergeChunk>;
  readonly conflictCount: number;
}

export type CovenConflictChoice = "mine" | "theirs" | "both";

const splitLines = (text: string): Array<string> => text.replace(/\r\n?/g, "\n").split("\n");

/** Pairs of equal line indexes [baseIndex, otherIndex] along a longest common subsequence. */
function matchLines(
  base: ReadonlyArray<string>,
  other: ReadonlyArray<string>,
): Array<readonly [number, number]> {
  const n = base.length;
  const m = other.length;
  const table: Array<Uint32Array> = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = base[i] === other[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const pairs: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === other[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

const sameLines = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

export function mergeCovenSources(base: string, mine: string, theirs: string): CovenMergeResult {
  const baseLines = splitLines(base);
  const mineLines = splitLines(mine);
  const theirLines = splitLines(theirs);
  const mineByBase = new Map(matchLines(baseLines, mineLines));
  const theirsByBase = new Map(matchLines(baseLines, theirLines));

  const chunks: Array<CovenMergeChunk> = [];
  let conflictCount = 0;
  const pushSame = (lines: ReadonlyArray<string>) => {
    if (lines.length === 0) return;
    const last = chunks.at(-1);
    if (last?.kind === "same")
      chunks[chunks.length - 1] = { kind: "same", lines: [...last.lines, ...lines] };
    else chunks.push({ kind: "same", lines });
  };

  let b = 0;
  let o = 0;
  let t = 0;
  while (b <= baseLines.length) {
    // Next base line that both sides kept unchanged, in order.
    let anchor = b;
    while (
      anchor < baseLines.length &&
      !((mineByBase.get(anchor) ?? -1) >= o && (theirsByBase.get(anchor) ?? -1) >= t)
    ) {
      anchor += 1;
    }
    const mineEnd = anchor < baseLines.length ? mineByBase.get(anchor)! : mineLines.length;
    const theirEnd = anchor < baseLines.length ? theirsByBase.get(anchor)! : theirLines.length;
    const baseGap = baseLines.slice(b, anchor);
    const mineGap = mineLines.slice(o, mineEnd);
    const theirGap = theirLines.slice(t, theirEnd);
    if (sameLines(mineGap, baseGap)) pushSame(theirGap);
    else if (sameLines(theirGap, baseGap) || sameLines(mineGap, theirGap)) pushSame(mineGap);
    else {
      chunks.push({ kind: "conflict", base: baseGap, mine: mineGap, theirs: theirGap });
      conflictCount += 1;
    }
    if (anchor >= baseLines.length) break;
    pushSame([baseLines[anchor]!]);
    b = anchor + 1;
    o = mineEnd + 1;
    t = theirEnd + 1;
  }
  return { chunks, conflictCount };
}

/** Builds the merged text, settling conflict N with choices[N] (default: keep mine). */
export function resolveCovenMerge(
  result: CovenMergeResult,
  choices: ReadonlyArray<CovenConflictChoice | undefined>,
): string {
  const lines: Array<string> = [];
  let conflict = 0;
  for (const chunk of result.chunks) {
    if (chunk.kind === "same") {
      lines.push(...chunk.lines);
      continue;
    }
    const choice = choices[conflict] ?? "mine";
    conflict += 1;
    if (choice === "mine" || choice === "both") lines.push(...chunk.mine);
    if (choice === "theirs" || choice === "both") lines.push(...chunk.theirs);
  }
  return lines.join("\n");
}
