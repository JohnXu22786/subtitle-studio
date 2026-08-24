/**
 * Lightweight cost estimation for LLM translation.
 *
 * Token counting is a heuristic (there is no perfect public tokenizer for an
 * arbitrary model). CJK characters are weighted at ~1 token each, other
 * characters at ~0.25 per token, which tracks the common "4 chars ≈ 1 token"
 * rule of thumb for Latin scripts and the denser coding of ideographs.
 *
 * Prices are *approximate list prices* keyed by model and can always be
 * overridden with explicit per-million rates.
 */

import { isCjkChar } from '../core/types.js'

export interface ModelRates {
  /** USD per 1M input (prompt) tokens. */
  inputPerMillion: number
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number
}

/** Approximate list prices (USD per 1M tokens). Override via settings. */
export const KNOWN_MODEL_RATES: Record<string, ModelRates> = {
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19 },
}

export const DEFAULT_RATES: ModelRates = { inputPerMillion: 0.27, outputPerMillion: 1.1 }

export function ratesForModel(model: string): ModelRates {
  return KNOWN_MODEL_RATES[model] ?? DEFAULT_RATES
}

/** Heuristic token estimate for an arbitrary text fragment. */
export function estimateTokens(text: string): number {
  let units = 0
  for (const ch of text) {
    units += isCjkChar(ch.codePointAt(0) ?? 0) ? 1 : 0.25
  }
  return Math.ceil(units)
}

export interface CostBreakdown {
  inputTokens: number
  outputTokens: number
  inputUsd: number
  outputUsd: number
  totalUsd: number
  modelRates: ModelRates
}

/** Cost for one request, given measured/estimated tokens. */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  rates: ModelRates = DEFAULT_RATES,
): CostBreakdown {
  const inputUsd = (inputTokens / 1_000_000) * rates.inputPerMillion
  const outputUsd = (outputTokens / 1_000_000) * rates.outputPerMillion
  return {
    inputTokens,
    outputTokens,
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    modelRates: rates,
  }
}

/** Format a cost breakdown as a compact human-readable string. */
export function formatCost(cost: CostBreakdown): string {
  const usd = (v: number) => `$${v.toFixed(4)}`
  return `${cost.inputTokens} in / ${cost.outputTokens} out tokens, ${usd(cost.inputUsd)} in + ${usd(cost.outputUsd)} out = ${usd(cost.totalUsd)}`
}