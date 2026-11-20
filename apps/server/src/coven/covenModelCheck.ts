import type { CovenDefinition } from "@t3tools/contracts";

export interface CovenCatalogOption {
  readonly id: string;
  readonly values: ReadonlyArray<string | boolean>;
  readonly default?: string | boolean | undefined;
}

export interface CovenCatalogProvider {
  readonly providerInstanceId: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly options?: ReadonlyArray<CovenCatalogOption> | undefined;
  }>;
}

export interface CovenModelIssue {
  readonly path: string;
  readonly message: string;
}

/** Candidates whose provider/model is missing from the catalog, so a lookup by id can fill them in. */
export function covenCandidateRefs(
  definition: CovenDefinition,
): ReadonlyArray<{ readonly providerInstanceId: string; readonly modelId: string }> {
  const seen = new Map<string, { providerInstanceId: string; modelId: string }>();
  for (const role of definition.frontMatter.roles) {
    for (const candidate of role.candidates) {
      seen.set(`${candidate.providerInstanceId}\u0000${candidate.modelId}`, {
        providerInstanceId: candidate.providerInstanceId,
        modelId: candidate.modelId,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Checks every role candidate against the provider catalog: the provider and model exist, and
 * each option names a real option of that model with an allowed value.
 */
export function checkCovenModels(
  definition: CovenDefinition,
  providers: ReadonlyArray<CovenCatalogProvider>,
): ReadonlyArray<CovenModelIssue> {
  const issues: Array<CovenModelIssue> = [];
  definition.frontMatter.roles.forEach((role, roleIndex) => {
    role.candidates.forEach((candidate, candidateIndex) => {
      const path = `roles[${roleIndex}].candidates[${candidateIndex}]`;
      const provider = providers.find(
        (entry) => entry.providerInstanceId === candidate.providerInstanceId,
      );
      if (provider === undefined) {
        issues.push({
          path,
          message: `Provider ${candidate.providerInstanceId} isn't available. Known providers: ${providers.map((entry) => entry.providerInstanceId).join(", ") || "none"}.`,
        });
        return;
      }
      const model = provider.models.find((entry) => entry.id === candidate.modelId);
      if (model === undefined) {
        issues.push({
          path,
          message: `Model ${candidate.modelId} isn't offered by ${candidate.providerInstanceId}.`,
        });
        return;
      }
      const known = model.options ?? [];
      for (const [optionId, value] of Object.entries(candidate.options ?? {})) {
        const option = known.find((entry) => entry.id === optionId);
        if (option === undefined) {
          issues.push({
            path: `${path}.options.${optionId}`,
            message:
              known.length === 0
                ? `${candidate.modelId} has no options, so ${optionId} would be ignored.`
                : `${candidate.modelId} has no option ${optionId}. Its options: ${known.map((entry) => entry.id).join(", ")}.`,
          });
          continue;
        }
        if (!option.values.some((allowed) => allowed === value)) {
          issues.push({
            path: `${path}.options.${optionId}`,
            message: `${optionId} for ${candidate.modelId} must be one of: ${option.values.map(String).join(", ")}.`,
          });
        }
      }
    });
  });
  return issues;
}
