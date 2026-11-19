import type { CovenSummary } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";

export const NO_COVEN = "__none__";

/** Every query word must appear in the coven's name, id, slug, aliases or description. */
function covenMatchesQuery(coven: CovenSummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [coven.name, coven.id, coven.slug, coven.description ?? "", ...coven.aliases]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function CovenPicker(props: {
  readonly covens: ReadonlyArray<CovenSummary>;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChoose: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = props.covens.filter((coven) => covenMatchesQuery(coven, query));
  const showNone = query.trim() === "" || "no coven off none".includes(query.trim().toLowerCase());
  const items = [...(showNone ? [NO_COVEN] : []), ...matches.map((coven) => coven.id)];
  const current = props.covens.find((coven) => coven.id === props.value);
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const choose = (value: string) => {
    close(false);
    if (value !== (props.value ?? NO_COVEN)) props.onChoose(value);
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      open={open && !props.disabled}
      onOpenChange={close}
      value={props.value ?? NO_COVEN}
      onValueChange={(value) => {
        if (typeof value === "string") choose(value);
      }}
    >
      <div className="px-2">
        <ComboboxTrigger
          disabled={props.disabled}
          aria-label="Coven for this thread"
          render={<Button variant="outline" size="sm" />}
          className="w-full justify-between"
        >
          <span className="truncate">{current?.name ?? "No coven"}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </ComboboxTrigger>
      </div>
      <ComboboxPopup className="flex w-72 flex-col">
        <ComboboxSearchInput
          placeholder="Search covens..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No coven matches.</ComboboxEmpty>
        <ComboboxList>
          {items.map((value, index) => {
            const coven = props.covens.find((entry) => entry.id === value);
            const selected = value === (props.value ?? NO_COVEN);
            return (
              <ComboboxItem key={value} value={value} index={index} hideIndicator>
                <div className="flex w-full min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{coven?.name ?? "No coven"}</span>
                    {coven?.description ? (
                      <span className="truncate text-muted-foreground text-xs">
                        {coven.description}
                      </span>
                    ) : null}
                  </div>
                  {selected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
