import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { getDisplayModelName } from "../chat/providerIconUtils";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

export interface CovenCandidateDescription {
  /** The name the model picker shows, or the raw id when the model isn't known. */
  readonly modelLabel: string;
  /** False when the providers have loaded and this provider or model isn't among them. */
  readonly modelKnown: boolean;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly value: string;
    /** Why the option won't apply, or null when it's a real option with an allowed value. */
    readonly problem: string | null;
  }>;
}

/** Providers for an environment: the primary one's from its own atom, others from the registry. */
export function useCovenProviders(environmentId: EnvironmentId): ReadonlyArray<ServerProvider> {
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  return (
    providersByEnvironment.get(environmentId) ??
    (environmentId === primaryEnvironmentId ? primaryProviders : EMPTY_PROVIDERS)
  );
}

/** Explains a coven candidate in picker terms: friendly model name and each option's label and value. */
export function describeCovenCandidate(
  providers: ReadonlyArray<ServerProvider>,
  candidate: {
    readonly providerInstanceId: string;
    readonly modelId: string;
    readonly options?: { readonly [key: string]: unknown } | undefined;
  },
): CovenCandidateDescription {
  const loaded = providers.length > 0;
  const provider = providers.find((entry) => entry.instanceId === candidate.providerInstanceId);
  const model = provider?.models.find((entry) => entry.slug === candidate.modelId);
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const options = Object.entries(candidate.options ?? {}).map(([id, raw]) => {
    const value =
      typeof raw === "string" || typeof raw === "boolean" ? String(raw) : JSON.stringify(raw);
    const descriptor = descriptors.find((entry) => entry.id === id);
    if (descriptor === undefined) {
      return {
        id,
        label: id,
        value,
        problem:
          model === undefined
            ? null
            : descriptors.length === 0
              ? "This model has no options, so it's ignored."
              : `Not an option of this model. Its options: ${descriptors.map((entry) => entry.id).join(", ")}.`,
      };
    }
    if (descriptor.type === "boolean") {
      return {
        id,
        label: descriptor.label,
        value: raw === true ? "on" : raw === false ? "off" : value,
        problem: typeof raw === "boolean" ? null : "Expects true or false.",
      };
    }
    const choice = descriptor.options.find((entry) => entry.id === raw);
    return {
      id,
      label: descriptor.label,
      value: choice?.label ?? value,
      problem:
        choice === undefined
          ? `Must be one of: ${descriptor.options.map((entry) => entry.id).join(", ")}.`
          : null,
    };
  });
  return {
    modelLabel: model ? getDisplayModelName(model) : candidate.modelId,
    modelKnown: !loaded || model !== undefined,
    options,
  };
}
