/**
 * Plugin configuration and defaults.
 *
 * The same configuration document drives the CLI, the dsh plugin, and the
 * batch runner. Placeholders of the form `${VAR}` inside string values are
 * expanded from environment variables, so API keys can be injected.
 */

import type { LlmSettings } from './translate/llm.js'
import type { BilingualLayout, SubtitleFormat } from './core/types.js'

export interface BatchSettings {
  concurrency?: number
  maxRetries?: number
  retryDelayMs?: number
  checkpoint?: string
  resume?: boolean
  retryFailed?: boolean
}

export interface GlossarySettings {
  paths?: string[]
}

export interface OutputSettings {
  format?: SubtitleFormat
  layout?: BilingualLayout
  separator?: string
  tagTarget?: string
  utf8Bom?: boolean
}

export interface ValidationSettings {
  maxChars?: number
  maxWords?: number
}

export interface PluginConfig {
  llm?: LlmSettings
  sourceLanguage?: string
  targetLanguages?: string[]
  glossary?: GlossarySettings
  output?: OutputSettings
  batch?: BatchSettings
  validation?: ValidationSettings
  /** Keys the plugin should respect when reading the host context. */
  cwd?: string
}

export interface ResolvedConfig {
  llm: Required<Pick<LlmSettings, 'provider' | 'baseUrl' | 'model' | 'timeoutMs' | 'maxRetries' | 'temperature' | 'jsonMode'>> &
    Pick<LlmSettings, 'apiKey'>
  sourceLanguage: string
  targetLanguages: string[]
  glossaryPaths: string[]
  layout: BilingualLayout
  separator: string
  tagTarget: string | undefined
  outputFormat: SubtitleFormat | undefined
  utf8Bom: boolean
  concurrency: number
  maxRetries: number
  retryDelayMs: number
  checkpointPath: string
  resume: boolean
  retryFailed: boolean
  maxChars: number
  maxWords: number
  chunkChars: number
}

export const DEFAULT_CONFIG: Omit<ResolvedConfig, 'sourceLanguage' | 'targetLanguages' | 'glossaryPaths'> = {
  llm: {
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: undefined,
    model: 'deepseek-chat',
    timeoutMs: 120_000,
    maxRetries: 2,
    temperature: 0.2,
    jsonMode: true,
  },
  layout: 'stacked',
  separator: '',
  tagTarget: undefined,
  outputFormat: undefined,
  utf8Bom: false,
  concurrency: 2,
  maxRetries: 2,
  retryDelayMs: 2_000,
  checkpointPath: 'subtitle-studio.checkpoint.json',
  resume: false,
  retryFailed: true,
  maxChars: 160,
  maxWords: 40,
  chunkChars: 3500,
}

/** Expand `${VAR}` (and `$VAR`) references from the environment. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, a: string | undefined, b: string | undefined) => {
    const name = a ?? b
    return name !== undefined && process.env[name] !== undefined ? process.env[name]! : ''
  })
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  throw new TypeError(`config field "${field}" must be a string or an array of strings`)
}

/** Merge user config over defaults and validate types. */
export function resolveConfig(user: Partial<PluginConfig> | undefined): ResolvedConfig {
  const u = user ?? {}
  const llm = u.llm ?? {}
  const output = u.output ?? {}
  const batch = u.batch ?? {}
  const validation = u.validation ?? {}
  const glossary = u.glossary ?? {}

  const provider = llm.provider ?? 'openai'
  if (provider !== 'openai' && provider !== 'dsh') {
    throw new TypeError(`config.llm.provider must be "openai" or "dsh", got ${JSON.stringify(provider)}`)
  }

  const baseUrl = expandEnv(llm.baseUrl ?? DEFAULT_CONFIG.llm.baseUrl)
  const apiKey = llm.apiKey === undefined ? undefined : expandEnv(llm.apiKey)

  const targetLanguages = asStringArray(u.targetLanguages ?? [], 'targetLanguages').map((l) => l.toLowerCase())
  const glossaryPaths = asStringArray(glossary.paths ?? [], 'glossary.paths')

  if (validation.maxChars !== undefined && (typeof validation.maxChars !== 'number' || !Number.isFinite(validation.maxChars) || validation.maxChars <= 0)) {
    throw new TypeError('config.validation.maxChars must be a positive number')
  }
  if (validation.maxWords !== undefined && (typeof validation.maxWords !== 'number' || !Number.isFinite(validation.maxWords) || validation.maxWords <= 0)) {
    throw new TypeError('config.validation.maxWords must be a positive number')
  }

  const layout = output.layout ?? DEFAULT_CONFIG.layout
  if (layout !== 'stacked' && layout !== 'interleaved') {
    throw new TypeError('config.output.layout must be "stacked" or "interleaved"')
  }
  const outputFormat = output.format
  if (outputFormat !== undefined && outputFormat !== 'srt' && outputFormat !== 'vtt') {
    throw new TypeError('config.output.format must be "srt" or "vtt"')
  }

  const concurrency = batch.concurrency ?? DEFAULT_CONFIG.concurrency
  if (typeof concurrency !== 'number' || !Number.isFinite(concurrency) || concurrency < 1) {
    throw new TypeError('config.batch.concurrency must be a positive integer')
  }
  const maxRetries = batch.maxRetries ?? DEFAULT_CONFIG.maxRetries
  if (typeof maxRetries !== 'number' || !Number.isFinite(maxRetries) || maxRetries < 0) {
    throw new TypeError('config.batch.maxRetries must be a non-negative integer')
  }

  const chunkChars = llm.chunkChars ?? DEFAULT_CONFIG.chunkChars
  if (typeof chunkChars !== 'number' || !Number.isFinite(chunkChars) || chunkChars < 200) {
    throw new TypeError('config.llm.chunkChars must be a number >= 200')
  }

  return {
    llm: {
      provider,
      baseUrl,
      apiKey,
      model: llm.model ?? DEFAULT_CONFIG.llm.model,
      timeoutMs: llm.timeoutMs ?? DEFAULT_CONFIG.llm.timeoutMs,
      maxRetries: llm.maxRetries ?? DEFAULT_CONFIG.llm.maxRetries,
      temperature: llm.temperature ?? DEFAULT_CONFIG.llm.temperature,
      jsonMode: llm.jsonMode ?? DEFAULT_CONFIG.llm.jsonMode,
    },
    sourceLanguage: u.sourceLanguage ?? '',
    targetLanguages,
    glossaryPaths,
    layout,
    separator: output.separator ?? DEFAULT_CONFIG.separator,
    tagTarget: output.tagTarget,
    outputFormat,
    utf8Bom: output.utf8Bom ?? DEFAULT_CONFIG.utf8Bom,
    concurrency,
    maxRetries,
    retryDelayMs: batch.retryDelayMs ?? DEFAULT_CONFIG.retryDelayMs,
    checkpointPath: batch.checkpoint ?? DEFAULT_CONFIG.checkpointPath,
    resume: batch.resume ?? DEFAULT_CONFIG.resume,
    retryFailed: batch.retryFailed ?? DEFAULT_CONFIG.retryFailed,
    maxChars: validation.maxChars ?? DEFAULT_CONFIG.maxChars,
    maxWords: validation.maxWords ?? DEFAULT_CONFIG.maxWords,
    chunkChars,
  }
}

/** Build an LLM settings object with overrides applied on top of config. */
export function llmSettingsWith(config: ResolvedConfig, overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    ...config.llm,
    ...overrides,
    baseUrl: overrides.baseUrl === undefined ? config.llm.baseUrl : expandEnv(overrides.baseUrl),
    apiKey: overrides.apiKey === undefined ? config.llm.apiKey : expandEnv(overrides.apiKey),
  }
}