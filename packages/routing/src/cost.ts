import type { ModelDefinition, TokenEstimate } from "@vartma/canonical";

export function estimateRequestCost(estimate: TokenEstimate, model: ModelDefinition): number {
  return (
    (estimate.inputTokens * model.pricing.inputPerMillion +
      estimate.expectedOutputTokens * model.pricing.outputPerMillion) /
    1_000_000
  );
}
