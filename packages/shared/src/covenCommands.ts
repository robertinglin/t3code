export type CovenCommand =
  | { readonly kind: "help" }
  | { readonly kind: "list" }
  | { readonly kind: "off" }
  | { readonly kind: "status" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "stop" }
  | { readonly kind: "approve"; readonly note: string | null }
  | { readonly kind: "reject"; readonly note: string | null }
  | { readonly kind: "change"; readonly name: string }
  | { readonly kind: "show"; readonly name: string | null }
  | { readonly kind: "edit"; readonly name: string | null }
  | { readonly kind: "export"; readonly name: string | null }
  | { readonly kind: "build"; readonly prompt: string }
  | { readonly kind: "build-edit"; readonly name: string }
  | { readonly kind: "invalid"; readonly message: string };

const COVEN_COMMAND = /^\/(coven-build|coven)(?=\s|$)([\s\S]*)$/i;

function unquote(text: string): string {
  const trimmed = text.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2]! : trimmed).trim();
}

/** True when the prompt is a `/coven` or `/coven-build` command the app handles itself. */
export function parseCovenCommand(prompt: string): CovenCommand | null {
  const match = COVEN_COMMAND.exec(prompt.trim());
  if (!match) return null;
  const command = match[1]!.toLowerCase();
  const rest = match[2]!.trim();
  if (command === "coven-build") {
    const edit = /^edit(?:\s+([\s\S]+))?$/i.exec(rest);
    if (edit) {
      const name = unquote(edit[1] ?? "");
      return name
        ? { kind: "build-edit", name }
        : { kind: "invalid", message: "Name the coven to edit: /coven-build edit <name>" };
    }
    return { kind: "build", prompt: rest };
  }
  const [verbRaw = "", ...argParts] = rest.split(/\s+/);
  const verb = verbRaw.toLowerCase();
  const arg = unquote(rest.slice(verbRaw.length));
  switch (verb) {
    case "":
    case "help":
      return { kind: "help" };
    case "list":
      return { kind: "list" };
    case "off":
    case "none":
      return { kind: "off" };
    case "status":
      return { kind: "status" };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "stop":
      return { kind: "stop" };
    case "approve":
      return { kind: "approve", note: arg || null };
    case "reject":
      return { kind: "reject", note: arg || null };
    case "show":
      return { kind: "show", name: arg || null };
    case "edit":
      return { kind: "edit", name: arg || null };
    case "export":
      return { kind: "export", name: arg || null };
    case "change":
    case "use": {
      const name = unquote(argParts[0]?.toLowerCase() === "to" ? arg.replace(/^to\s+/i, "") : arg);
      return name
        ? { kind: "change", name }
        : { kind: "invalid", message: "Name the coven: /coven change <name>" };
    }
    default:
      return {
        kind: "invalid",
        message: `Unknown /coven command "${verbRaw}". Try /coven help.`,
      };
  }
}

export interface CovenNameCandidate {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
}

function normalizeName(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolves a user-typed name: exact id/slug/name/alias match first, then a unique prefix.
 * Returns every match when the name is ambiguous so the caller can ask.
 */
export function resolveCovenName<T extends CovenNameCandidate>(
  name: string,
  covens: ReadonlyArray<T>,
): { readonly match: T | null; readonly ambiguous: ReadonlyArray<T> } {
  const wanted = normalizeName(name);
  if (!wanted) return { match: null, ambiguous: [] };
  const keys = (coven: T) => [
    coven.id.toLowerCase(),
    coven.slug,
    normalizeName(coven.name),
    ...coven.aliases.map(normalizeName),
  ];
  const exact = covens.filter((coven) => keys(coven).includes(wanted));
  if (exact.length === 1) return { match: exact[0]!, ambiguous: [] };
  if (exact.length > 1) return { match: null, ambiguous: exact };
  const prefix = covens.filter((coven) => keys(coven).some((key) => key.startsWith(wanted)));
  if (prefix.length === 1) return { match: prefix[0]!, ambiguous: [] };
  return { match: null, ambiguous: prefix };
}

export const COVEN_HELP_TEXT = [
  "/coven list: show saved covens",
  "/coven change <name>: use a coven in this thread",
  "/coven off: stop using a coven in this thread",
  "/coven show [name]: show a coven's roles",
  "/coven edit [name]: open the coven editor",
  "/coven status: show this thread's coven run",
  "/coven pause | resume: hold or continue the run",
  "/coven stop: cancel the run",
  "/coven approve [note] | reject [note]: decide the waiting plan or gate",
  "/coven export [name]: copy the definition",
  "/coven-build <description>: start a new coven from a description",
  "/coven-build edit <name>: revise a coven",
].join("\n");
