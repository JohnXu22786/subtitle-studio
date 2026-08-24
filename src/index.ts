/**
 * DeepSeek Harness plugin entry (`apply(ctx, config)`).
 *
 * This module is the bundle's entry point. It registers five tools on the
 * harness `ctx.tools` service when the harness provides one, and exposes a
 * `subtitleStudio` service (parse/translate/merge/validate/glossary helpers)
 * when `ctx.provide` exists.
 *
 * The module deliberately never imports `@deepseek-ai/cordis`: the context is
 * consumed structurally, so the same entry compiles and runs standalone (no
 * harness installed) and inside a real dsh profile alike.
 */

import { resolveConfig, type PluginConfig, type ResolvedConfig } from './config.js'
import {
  registerToolsOn,
  type CordisContextLike,
  type ToolEnvironment,
  type JsonValue,
} from './tools/tools.js'
import { readSubtitleFile, writeSubtitleFile } from './core/subtitle.js'
import { parseSubtitle, stringifySubtitle, convertSubtitle, detectFormat } from './core/subtitle.js'
import { mergeBilingual, mergeWithEntries } from './merge/merge.js'
import {
  validateSubtitle,
  validateTranslationAlignment,
  formatIssues,
  summarizeIssues,
} from './validate/validate.js'
import {
  loadGlossaryFile,
  saveGlossaryFile,
  mergeGlossaries,
  upsertEntry,
  removeEntries,
  buildGlossaryPrompt as buildGlossaryPromptText,
  formatGlossary,
} from './translate/glossary.js'
import { translateCues, translateDocument, parseTranslationPayload } from './translate/translate.js'
import { createLlmClient, type LlmSeam } from './translate/llm.js'
import { estimateCost, estimateTokens, ratesForModel, formatCost } from './translate/cost.js'
import { isAbsolute, resolve } from 'node:path'

/** Plugin name as shown in the harness. */
export const name = 'subtitle-studio'

/** List of required services (kept empty: tools/llm are consumed optionally). */
export const inject: string[] = []

/** Public API surface provided as the `subtitleStudio` service. */
export interface SubtitleStudioService {
  parse(file: string, options?: { format?: 'srt' | 'vtt' }): ReturnType<typeof readSubtitleFile>['result']
  translate(
    document: import('./core/types.js').SubtitleDocument,
    targets: string[],
    options?: Partial<{ source: string; jsonMode: boolean; chunkChars: number }>,
  ): Promise<import('./translate/translate.js').TranslationOutcome[]>
  merge(
    document: import('./core/types.js').SubtitleDocument,
    results: import('./core/types.js').TranslationResult[],
    options?: Partial<import('./merge/merge.js').MergeOptions>,
  ): import('./core/types.js').SubtitleDocument
  validate: {
    subtitle(document: import('./core/types.js').SubtitleDocument): import('./validate/validate.js').Issue[]
    alignment(
      document: import('./core/types.js').SubtitleDocument,
      results: import('./core/types.js').TranslationResult[],
    ): import('./validate/validate.js').Issue[]
  }
  glossary: {
    load(path: string): import('./translate/glossary.js').Glossary
    save(path: string, glossary: import('./translate/glossary.js').Glossary): void
    add(glossary: import('./translate/glossary.js').Glossary, entry: import('./translate/glossary.js').GlossaryEntry): import('./translate/glossary.js').Glossary
    remove(glossary: import('./translate/glossary.js').Glossary, source: string, target?: string): number
    merge(...glossaries: Array<import('./translate/glossary.js').Glossary>): import('./translate/glossary.js').Glossary
    prompt(glossary: import('./translate/glossary.js').Glossary, target: string): string
  }
  cost: {
    estimate(text: string): number
    breakdown(inputTokens: number, outputTokens: number, model?: string): import('./translate/cost.js').CostBreakdown
  }
  stringify(document: import('./core/types.js').SubtitleDocument): string
  convert(document: import('./core/types.js').SubtitleDocument, format: 'srt' | 'vtt'): import('./core/types.js').SubtitleDocument
}

function buildService(env: ToolEnvironment): SubtitleStudioService {
  const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(env.cwd ?? process.cwd(), p))
  return {
    parse(file, options = {}) {
      const absolute = resolvePath(file)
      return readSubtitleFile(absolute, { format: options.format }).result
    },
    translate: async (document, targets, options = {}) =>
      translateDocument(document.cues, {
        client: createLlmClient(
          { ...env.config.llm, jsonMode: options.jsonMode ?? env.config.llm.jsonMode },
          { seam: env.seam },
        ),
        source: options.source ?? (env.config.sourceLanguage || 'auto'),
        targets,
        jsonMode: options.jsonMode ?? env.config.llm.jsonMode,
        chunkChars: options.chunkChars ?? env.config.chunkChars,
      }),
    merge: (document, results, options = {}) => mergeBilingual(document, results, options),
    validate: {
      subtitle: (document) => validateSubtitle(document),
      alignment: (document, results) =>
        validateTranslationAlignment(document, results, {
          maxChars: env.config.maxChars,
          maxWords: env.config.maxWords,
        }),
    },
    glossary: {
      load: (path) => loadGlossaryFile(resolvePath(path)),
      save: (path, glossary) => saveGlossaryFile(resolvePath(path), glossary),
      add: (glossary, entry) => upsertEntry(glossary, entry),
      remove: (glossary, source, target) => removeEntries(glossary, source, target),
      merge: (...glossaries) => mergeGlossaries(glossaries),
      prompt: (glossary, target) => buildGlossaryPromptText(glossary, target),
    },
    cost: {
      estimate: (text) => estimateTokens(text),
      breakdown: (inputTokens, outputTokens, model) =>
        estimateCost(inputTokens, outputTokens, ratesForModel(model ?? env.config.llm.model)),
    },
    stringify: (document) => stringifySubtitle(document),
    convert: (document, format) => convertSubtitle(document, format),
  }
}

/** Extract a structural `ctx.llm` seam from the harness context, if any. */
function extractSeam(ctx: Record<string, unknown>): LlmSeam | undefined {
  const llm = ctx['llm'] as { stream?: unknown } | undefined
  if (!llm || typeof llm !== 'object') return undefined
  return llm as LlmSeam
}

/**
 * Standard Cordis plugin entry.
 *
 * @param ctx the harness context (structural: `tools`, `inject`, `provide`, ...)
 * @param config JSON configuration from the profile patch (see README)
 */
export function apply(ctx: CordisContextLike & Record<string, unknown>, config: Partial<PluginConfig> = {}): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const env: ToolEnvironment = {
    config: resolved,
    seam: resolved.llm.provider === 'dsh' ? extractSeam(ctx) : undefined,
    cwd: config.cwd,
  }

  const disposers = registerToolsOn(ctx, env)

  let serviceDispose: unknown
  if (typeof ctx.provide === 'function') {
    serviceDispose = ctx.provide('subtitleStudio', buildService(env))
  }

  const cleanup = (): void => {
    for (const dispose of disposers) dispose()
    if (typeof serviceDispose === 'function') (serviceDispose as () => void)()
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', cleanup)
  }
}

export {
  resolveConfig,
  parseSubtitle,
  detectFormat,
  stringifySubtitle,
  convertSubtitle,
  translateCues,
  translateDocument,
  parseTranslationPayload,
  mergeBilingual,
  mergeWithEntries,
  validateSubtitle,
  validateTranslationAlignment,
  formatIssues,
  summarizeIssues,
  loadGlossaryFile,
  saveGlossaryFile,
  mergeGlossaries,
  upsertEntry,
  removeEntries,
  formatGlossary,
  createLlmClient,
  estimateCost,
  estimateTokens,
  ratesForModel,
  formatCost,
  writeSubtitleFile,
  type JsonValue,
}