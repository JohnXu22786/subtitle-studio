/**
 * Bilingual subtitle merging.
 *
 * Combines an original document with translations into a single document:
 *
 * - `stacked` (上下行): every cue contains the original lines followed by the
 *   translated lines.
 * - `interleaved` (交错): the original cue is followed by a translation cue
 *   carrying identical timestamps.
 *
 * Timestamps are always copied verbatim from the source — the timeline is
 * preserved to the millisecond by construction.
 */

import type {
  BilingualLayout,
  SubtitleCue,
  SubtitleDocument,
  TranslationEntry,
  TranslationResult,
} from '../core/types.js'

export interface MergeOptions {
  layout: BilingualLayout
  /** Line inserted between the original block and the translated block (stacked). */
  separator?: string
  /** Prefix each translated line with a tag when stacked/interleaved. */
  tagTarget?: string
  /** When a cue has no translation: keep the original alone (default) or drop it. */
  keepUntranslated?: boolean
}

const DEFAULTS: MergeOptions = {
  layout: 'stacked',
  separator: '',
  tagTarget: undefined,
  keepUntranslated: true,
}

function mergeOptions(options: Partial<MergeOptions>): MergeOptions {
  return { ...DEFAULTS, ...options }
}

function tagLines(text: string, tag?: string): string {
  const lines = text.split('\n')
  if (!tag) return text
  return lines.map((line) => `${tag}${line}`).join('\n')
}

/**
 * Merge a document with one or more translations.
 *
 * Every translation is used — nothing is silently dropped:
 * - `stacked` (上下行): each cue holds the original lines followed by the
 *   translated block(s); when several languages are merged, each block is
 *   prefixed per language.
 * - `interleaved` (交错): the original cue is followed by one same-timing
 *   translation cue per language.
 *
 * Timestamps are always copied verbatim from the source — the timeline is
 * preserved to the millisecond by construction.
 */
export function mergeBilingual(
  document: SubtitleDocument,
  translations: TranslationResult[],
  options: Partial<MergeOptions> = {},
): SubtitleDocument {
  const opts = mergeOptions(options)

  if (translations.length === 0) {
    return { ...document, cues: [...document.cues] }
  }

  const langs = translations.map((t) => t.target)
  const maps = translations.map((t) => new Map(t.entries.map((e) => [e.index, e] as const)))
  const multi = translations.length > 1

  /** Lines for one language's translation (undefined when absent/empty). */
  const block = (lang: string, li: number, cue: SubtitleCue): string[] | undefined => {
    const entry = maps[li]?.get(cue.index)
    if (!entry || entry.text.trim() === '') return undefined
    // Several languages need per-language tags to stay distinguishable.
    const tag = multi && opts.tagTarget === undefined ? `[${lang}] ` : opts.tagTarget
    return tagLines(entry.text.trim(), tag).split('\n')
  }

  const cues: SubtitleCue[] = []
  for (const cue of document.cues) {
    const blocks = langs.map((lang, li) => block(lang, li, cue))
    const hasAny = blocks.some((b) => b !== undefined)

    if (!hasAny) {
      if (opts.keepUntranslated) cues.push({ ...cue })
      continue
    }

    if (opts.layout === 'interleaved') {
      cues.push({ ...cue })
      for (let li = 0; li < blocks.length; li++) {
        const lines = blocks[li]
        if (!lines) continue
        const lang = langs[li]!
        cues.push({
          index: cue.index,
          start: cue.start,
          end: cue.end,
          text: lines.join('\n'),
          identifier: cue.identifier ? `${cue.identifier}-${lang}` : undefined,
          settings: cue.settings,
        })
      }
    } else {
      // stacked
      const parts = cue.text.split('\n')
      for (let li = 0; li < blocks.length; li++) {
        const lines = blocks[li]
        if (!lines) continue
        if (opts.separator) parts.push(opts.separator)
        parts.push(...lines)
      }
      cues.push({ ...cue, text: parts.join('\n') })
    }
  }

  return { format: document.format, cues, meta: document.meta }
}

/** Convenience when translations are already in `TranslationEntry` list form. */
export function mergeWithEntries(
  document: SubtitleDocument,
  source: string,
  target: string,
  entries: TranslationEntry[],
  options: Partial<MergeOptions> = {},
): SubtitleDocument {
  const result: TranslationResult = {
    target,
    source,
    entries,
    missing: [],
    extra: [],
    errors: [],
    chunkCount: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  return mergeBilingual(document, [result], options)
}

/** Human-readable one-line-per-cue preview (used by tool output). */
export function mergePreview(document: SubtitleDocument, maxCues = 5): Array<Record<string, unknown>> {
  return document.cues.slice(0, maxCues).map((cue) => ({
    index: cue.index,
    start: cue.start,
    end: cue.end,
    text: cue.text,
  }))
}