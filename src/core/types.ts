/**
 * Core data model for the subtitle-studio engine.
 *
 * Everything in this module is plain data — no I/O, no side effects — so the
 * shape can be shared freely between the CLI, the dsh tools, and the library
 * API.
 */

/** Subtitle container formats understood by the engine. */
export type SubtitleFormat = 'srt' | 'vtt'

/** Layout used when combining an original and a translation into one document. */
export type BilingualLayout = 'stacked' | 'interleaved'

/** A single timed subtitle cue.
 *
 * - `start`/`end` are absolute offsets in milliseconds.
 * - `text` may span multiple lines and preserves inner line breaks.
 * - `identifier` is only populated when parsing WebVTT (optional cue id).
 * - `settings` carries WebVTT cue settings (e.g. `align:start position:50%`),
 *   or the SRT position extension, verbatim.
 */
export interface SubtitleCue {
  index: number
  start: number
  end: number
  text: string
  identifier?: string
  settings?: string
}

/** A parsed subtitle document. */
export interface SubtitleDocument {
  format: SubtitleFormat
  cues: SubtitleCue[]
  /** Format-specific header metadata (VTT `Key: value` lines). */
  meta?: Record<string, string>
}

export type IssueKind = 'error' | 'warning'

/** A single diagnostic raised while parsing (never fatal by itself). */
export interface ParseIssue {
  kind: IssueKind
  /** 1-based line number in the source text when known. */
  line: number
  message: string
}

/** Result of a (tolerant) parse. `issues` never throws — parsers degrade. */
export interface ParseResult {
  document: SubtitleDocument
  issues: ParseIssue[]
}

/** One translated cue. */
export interface TranslationEntry {
  /** Index of the source cue this entry corresponds to. */
  index: number
  /** Translated text (may contain inner line breaks). */
  text: string
  /** Original source text, for reference / post-checks. */
  source: string
}

/** Aggregated translation outcome for one target language. */
export interface TranslationResult {
  target: string
  source: string
  entries: TranslationEntry[]
  /** Indices expected but absent or translated to empty text. */
  missing: number[]
  /** Indices that exist in the translation but not in the source document. */
  extra: number[]
  /** Human-readable errors collected while translating (non-fatal). */
  errors: string[]
  chunkCount: number
  usage: Usage
}

/** Token usage tracking. */
export interface Usage {
  inputTokens: number
  outputTokens: number
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 })

/** Helpers used across the codebase for stable comparisons. */

export function isCjkChar(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x2eff) || // CJK radicals
    (code >= 0x3000 && code <= 0x30ff) || // CJK punctuation, hiragana, katakana
    (code >= 0x3100 && code <= 0x312f) || // bopomofo
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) || // full-width forms
    (code >= 0x20000 && code <= 0x2fa1f) // CJK ext B & C (astral planes)
  )
}

/** Count non-whitespace CJK characters in a string (iterates by code point so
 *  astral-plane ideographs are counted correctly). */
export function countCjk(text: string): number {
  let count = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && isCjkChar(code)) count++
  }
  return count
}