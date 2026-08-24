/**
 * Sentence-by-sentence translation orchestration.
 *
 * Workflow per target language:
 *  1. split cues into chunks respecting a character budget;
 *  2. for each chunk, send source+index pairs to the LLM;
 *  3. robustly extract the JSON payload (array or object form, tolerance for
 *     prose wrappers, code fences, and alternate key names);
 *  4. reconcile by index, recording missing/extra entries;
 *  5. emit incremental partial results through a hook so callers can persist
 *     a mid-run checkpoint.
 *
 * Alignment is the core invariant: every cue index must come back exactly
 * once. Downstream validation turns any violation into a diagnostic.
 */

import type { SubtitleCue } from '../core/types.js'
import type { LLMClient, ChatMessage } from './llm.js'
import { buildGlossaryPrompt, type Glossary, entriesForTarget } from './glossary.js'
import { estimateTokens } from './cost.js'

export interface ChunkingOptions {
  /** Source-text character budget per request. */
  chunkChars: number
}

export interface TranslateLanguageOptions {
  client: LLMClient
  source: string
  target: string
  glossary?: Glossary
  jsonMode: boolean
  chunkChars?: number
  failedChunksAllowed?: number
}

export interface TranslationHook {
  /** Invoked after every translated chunk (useful for mid-run persistence). */
  onPartial?: (partial: PartialTranslation, chunkIndex: number, chunkCount: number) => void
}

export interface PartialTranslation {
  target: string
  /** index → translated text (JSON-serializable). */
  entries: Record<string, string>
  missing: number[]
  errors: string[]
  usage: { inputTokens: number; outputTokens: number }
}

export interface TranslationOutcome {
  target: string
  source: string
  entries: Array<{ index: number; text: string; source: string }>
  missing: number[]
  extra: number[]
  errors: string[]
  chunkCount: number
  usage: { inputTokens: number; outputTokens: number }
}

/** Split cues into chunks respecting a character budget. */
export function chunkCues(cues: SubtitleCue[], budget: number): Array<SubtitleCue[]> {
  const chunks: Array<SubtitleCue[]> = []
  let current: SubtitleCue[] = []
  let currentChars = 0
  for (const cue of cues) {
    const chars = cue.text.length + 4 // JSON overhead headroom
    if (current.length > 0 && currentChars + chars > budget) {
      chunks.push(current)
      current = []
      currentChars = 0
    }
    current.push(cue)
    currentChars += chars
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function buildSystemPrompt(
  source: string,
  target: string,
  glossary: Glossary | undefined,
  jsonMode: boolean,
): string {
  const shape = jsonMode
    ? '{"translations":[{"i":1,"t":"translated text"}, ...]}'
    : '[{"i":1,"t":"translated text"}, ...]'
  const lines = [
    `You are a professional film subtitle translator. Translate the subtitle cues below from ${source} to ${target}.`,
    'Rules:',
    '- Translate meaning faithfully and idiomatically; keep the tone of the original.',
    '- Preserve inner line breaks; keep each cue readable within about 3-4 seconds of screen time.',
    '- Never translate indices, tags, timestamps, or speaker markers such as <i>, <font>, {\an8} or &nbsp;.',
    '- Keep the number of objects identical to the input and keep the order.',
    `- Reply with ONLY a JSON payload in exactly this shape and nothing else (no prose, no fences): ${shape}`,
  ]
  if (glossary) {
    const prompt = buildGlossaryPrompt(glossary, target)
    if (prompt) lines.splice(4, 0, prompt)
  }
  return lines.join('\n')
}

/** Build the user message for one chunk. */
export function buildChunkMessage(cues: SubtitleCue[], jsonMode: boolean): string {
  const payload = cues.map((cue) => ({ i: cue.index, t: cue.text }))
  const body = JSON.stringify(payload)
  return jsonMode ? `{"cues":${body}}` : body
}

interface ParsedItem {
  index: number
  text: string | undefined
}

/** Extract the translation payload from an LLM completion. */
export function parseTranslationPayload(raw: string, expectedIndices: number[], jsonMode: boolean): ParsedItem[] {
  const cleaned = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/i, '')
    .replace(/```\s*$/, '')

  const items = extractItems(cleaned, jsonMode, expectedIndices)
  if (!items) {
    throw new Error(
      `translation response did not contain a JSON payload (mode=${jsonMode ? 'object' : 'array'})`,
    )
  }
  return items
}

function extractItems(text: string, jsonMode: boolean, expectedIndices: number[]): ParsedItem[] | undefined {
  const tryParse = (candidate: string) => {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      return undefined
    }
  }

  let parsed: unknown
  if (jsonMode) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) parsed = tryParse(text.slice(start, end + 1))
  } else {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start !== -1 && end > start) parsed = tryParse(text.slice(start, end + 1))
  }

  let array: unknown[] | undefined
  if (Array.isArray(parsed)) {
    array = parsed
  } else if (isRecord(parsed)) {
    for (const key of ['translations', 'items', 'cues', 'result', 'list']) {
      const value = parsed[key]
      if (Array.isArray(value)) {
        array = value
        break
      }
    }
  }
  if (!array) return undefined

  const out: ParsedItem[] = []
  for (const [position, item] of array.entries()) {
    if (!isRecord(item)) continue
    const index = readIndex(item, expectedIndices[position])
    if (index < 0) continue // unusable index — skip instead of corrupting alignment
    const text = readText(item)
    out.push({ index, text })
  }
  return out
}

function readIndex(item: Record<string, unknown>, fallback: number | undefined): number {
  for (const key of ['i', 'index', 'id', 'n']) {
    const value = item[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value)
  }
  // -1 is a sentinel meaning "no usable index": the item is skipped instead of
  // silently overwriting cue 1 with a mismatched translation.
  return fallback ?? -1
}

function readText(item: Record<string, unknown>): string | undefined {
  for (const key of ['t', 'text', 'translation', 'translated', 'content', 'value']) {
    const value = item[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Translate every cue of a document into one target language.
 *
 * @param cues source cues (indexes must be unique)
 * @param options translation options
 * @param hook progress/persistence callbacks
 * @param signal cancellation signal (aborts in-flight LLM calls)
 */
export async function translateCues(
  cues: SubtitleCue[],
  options: TranslateLanguageOptions,
  hook: TranslationHook = {},
  signal?: AbortSignal,
): Promise<TranslationOutcome> {
  const budget = options.chunkChars ?? 3500
  const chunks = chunkCues(cues, budget)
  const system = buildSystemPrompt(options.source, options.target, options.glossary, options.jsonMode)

  const entries = new Map<number, { text: string; source: string }>()
  const missing: number[] = []
  const errors: string[] = []
  const usage = { inputTokens: 0, outputTokens: 0 }

  const jsonMode = options.jsonMode
  const expectedByChunk = chunks.map((chunk) => chunk.map((cue) => cue.index))

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci] ?? []
    const expected = expectedByChunk[ci] ?? []
    const userMessage = buildChunkMessage(chunk, jsonMode)

    let raw: string | undefined
    let chunkUsage: { inputTokens?: number; outputTokens?: number } | undefined
    let attempts = 0
    const maxAttempts = 2
    while (true) {
      attempts++
      try {
        const messages: ChatMessage[] =
          attempts === 1
            ? [
                { role: 'system', content: system },
                { role: 'user', content: userMessage },
              ]
            : [
                { role: 'system', content: system },
                { role: 'user', content: userMessage },
                {
                  role: 'assistant',
                  content:
                    'Your previous response was not valid. Return only the exact JSON shape requested, no prose.',
                },
                { role: 'user', content: 'Retry now.' },
              ]
        const completion = await options.client.complete(messages, { jsonMode }, signal)
        raw = completion.text
        chunkUsage = completion.usage
        const parsed = parseTranslationPayload(raw, expected, jsonMode)
        for (const item of parsed) {
          if (item.text === undefined || item.text.trim() === '') {
            if (expected.includes(item.index)) missing.push(item.index)
            continue
          }
          const sourceCue = cues.find((cue) => cue.index === item.index)
          entries.set(item.index, { text: item.text, source: sourceCue?.text ?? '' })
        }
        // Reconcile: any expected index that was neither delivered nor flagged
        // as empty is a silently-dropped cue.
        for (const idx of expected) {
          if (!entries.has(idx) && !missing.includes(idx)) missing.push(idx)
        }
        break
      } catch (error) {
        const e = error as { retryable?: boolean; message?: string; status?: unknown }
        const msg = e?.message ?? String(error)
        // Caller-abort must stop everything, not be retried.
        if (signal?.aborted) {
          errors.push(`aborted: ${msg}`)
          for (const idx of expected) missing.push(idx)
          break
        }
        // Only malformed/parseable payloads get the corrective retry. Terminal
        // LlmErrors (auth, invalid request, aborted) and transient network
        // errors (already retried with backoff inside the client) surface now.
        const isLlmError = typeof e?.retryable === 'boolean'
        const terminal = isLlmError && !e.retryable
        if (!terminal && !isLlmError && attempts < maxAttempts) {
          continue
        }
        errors.push(`chunk ${ci + 1}/${chunks.length}: ${msg}`)
        for (const idx of expected) missing.push(idx)
        break
      }
    }

    if (chunkUsage?.inputTokens) usage.inputTokens += chunkUsage.inputTokens
    if (chunkUsage?.outputTokens) usage.outputTokens += chunkUsage.outputTokens

    const partial: PartialTranslation = {
      target: options.target,
      entries: Object.fromEntries(
        [...entries.entries()].map(([index, entry]) => [String(index), entry.text]),
      ),
      missing: [...missing],
      errors: [...errors],
      usage: {
        inputTokens: usage.inputTokens || estimateTokens(userMessage),
        outputTokens: usage.outputTokens || estimateTokens(raw ?? userMessage),
      },
    }
    hook.onPartial?.(partial, ci, chunks.length)
  }

  const extra = [...entries.keys()].filter((idx) => !cues.some((cue) => cue.index === idx))
  return {
    target: options.target,
    source: options.source,
    entries: cues.flatMap((cue) => {
      const e = entries.get(cue.index)
      return e ? [{ index: cue.index, text: e.text, source: e.source }] : []
    }),
    missing: [...new Set(missing)],
    extra,
    errors,
    chunkCount: chunks.length,
    usage: {
      inputTokens: usage.inputTokens || estimateTokens(cues.map((c) => c.text).join('\n')),
      outputTokens: usage.outputTokens,
    },
  }
}

/** Convenience: translate a single document for multiple target languages. */
export async function translateDocument(
  cues: SubtitleCue[],
  options: Omit<TranslateLanguageOptions, 'target'> & { targets: string[] },
  hook: TranslationHook = {},
  signal?: AbortSignal,
): Promise<TranslationOutcome[]> {
  const outcomes: TranslationOutcome[] = []
  for (const target of options.targets) {
    outcomes.push(
      await translateCues(cues, { ...options, target }, { ...hook, onPartial: hook.onPartial }, signal),
    )
  }
  return outcomes
}

/** Glossary entries actually applicable to a target (re-export for callers). */
export function applicableGlossaryEntries(glossary: Glossary, target: string | undefined) {
  return entriesForTarget(glossary, target)
}