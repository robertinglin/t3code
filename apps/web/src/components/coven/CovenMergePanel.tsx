import type { CovenConflictChoice, CovenMergeResult } from "@t3tools/shared/covenMerge";

import { T, useGT } from "gt-react";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const isChoice = (value: unknown): value is CovenConflictChoice =>
  value === "mine" || value === "theirs" || value === "both";

function LinesBlock({
  title,
  lines,
}: {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-muted-foreground text-xs">{title}</span>
      <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
        {lines.length === 0 ? (
          <span className="text-muted-foreground italic">
            <T>(removed)</T>
          </span>
        ) : (
          lines.join("\n")
        )}
      </pre>
    </div>
  );
}

/**
 * Settles the overlapping edits of a three-way merge. Changes made on only
 * one side are already merged; each conflict shows both versions side by
 * side and the user keeps one, the other, or both.
 */
export function CovenMergePanel(props: {
  readonly result: CovenMergeResult;
  readonly choices: ReadonlyArray<CovenConflictChoice | undefined>;
  readonly theirsLabel: string;
  readonly onChoose: (index: number, choice: CovenConflictChoice) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const conflicts = props.result.chunks.flatMap((chunk) =>
    chunk.kind === "conflict" ? [chunk] : [],
  );
  const settled = conflicts.every((_, index) => props.choices[index] !== undefined);
  return (
    <div className="flex flex-col gap-3" role="region" aria-label={gt("Merge changes")}>
      <p className="text-xs">
        {gt(
          "{count, plural, =1 {One part was changed on both sides.} other {{count} parts were changed on both sides.}} Everything else is merged. Choose what to keep for each part, then apply.",
          { count: conflicts.length },
        )}
      </p>
      {conflicts.map((conflict, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- conflicts are positional and the list never reorders
        <div key={index} className="flex flex-col gap-2 rounded-lg border border-border p-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <LinesBlock title={gt("Your edit")} lines={conflict.mine} />
            <LinesBlock title={props.theirsLabel} lines={conflict.theirs} />
          </div>
          <ToggleGroup
            aria-label={gt("Conflict {number}", { number: index + 1 })}
            value={props.choices[index] === undefined ? [] : [props.choices[index]]}
            onValueChange={(next) => {
              const value = next[0];
              if (isChoice(value)) props.onChoose(index, value);
            }}
          >
            <Toggle value="mine">
              <T>Keep mine</T>
            </Toggle>
            <Toggle value="theirs">
              <T>Use theirs</T>
            </Toggle>
            <Toggle value="both">
              <T>Keep both</T>
            </Toggle>
          </ToggleGroup>
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          <T>Not now</T>
        </Button>
        <Button size="sm" disabled={!settled} onClick={props.onApply}>
          <T>Apply merge</T>
        </Button>
      </div>
    </div>
  );
}
